# Plan: `REVIEW_TASKS_AS_APPROVALS` — review subtasks as Asana Approvals

Implementation plan for a new opt-in action input that creates the per-reviewer
review subtasks as Asana **approval** tasks, and then drives their approval
status from the Github review verdict (`Approved` / `Changes Requested` /
`Rejected`).

Today (`src/main.ts`) review subtasks are ordinary tasks and the only signal we
sync is `completed`: a subtask is created/reopened on `review_requested`,
completed when that reviewer approves, and all remaining subtasks are completed
when the PR closes. A reviewer looking at Asana cannot tell "I approved this"
from "the PR was closed under me" from "I asked for changes".

## 1. What Asana gives us

Verified against the Asana OpenAPI spec (`Asana/openapi`, `defs/asana_oas.yaml`)
and the vendored client in `node_modules/asana`:

- `TaskCompact.resource_subtype` accepts `default_task | milestone | approval |
  custom` and is **not** `readOnly`.
- `TaskBase.approval_status` accepts `pending | approved | rejected |
  changes_requested`, with this description:

  > *Conditional* Reflects the approval status of this task. This field is kept
  > in sync with `completed`, meaning `pending` translates to false while
  > `approved`, `rejected`, and `changes_requested` translate to true. If you
  > set completed to true, this field will be set to `approved`.

- Both fields are reachable from `TaskCreateRequest` and `TaskUpdateRequest`
  (both `allOf` → `TaskRequestBase` → `TaskBase` → `TaskCompact`), and
  `POST /tasks/{task_gid}/subtasks` takes a `TaskCreateRequest` — so we can set
  them on the subtask-creation call the action already makes.
- The `asana` npm client passes request bodies straight through
  (`createTaskWithHttpInfo`/`createSubtaskForTaskWithHttpInfo` do
  `var postBody = body`), so no client-side field whitelist blocks these; the
  existing `nock`-level integration mocks will see them verbatim.

Two consequences that shape the design:

1. **`completed` and `approval_status` are the same bit of state.** Setting
   `approval_status: 'changes_requested'` or `'rejected'` *completes* the
   subtask; setting `completed: true` silently means `approved`. So every place
   the current code writes `completed` on a review subtask has to become
   status-aware, or approvals will read "Approved" for outcomes that were not
   approvals.
2. **Converting an existing task to an approval is the risky part.** The spec
   says `resource_subtype` is writable, but there are
   [reports](https://forum.asana.com/t/mark-task-as-approval-via-api/798803)
   that a `PUT` with `resource_subtype: approval` returns `200` without actually
   converting the task. Setting `approval_status` on a task that is still a
   `default_task` is documented as *Conditional* and may be rejected. So
   conversion is best-effort with a fallback, never a hard dependency
   (see §4). Approvals may also be a paid-tier Asana feature, which is a second
   reason the whole thing is opt-in and must degrade rather than fail.

## 2. Open decision: where does "Rejected" come from?

Github review states are `approved`, `changes_requested`, `commented`,
`dismissed` (lowercase in webhook payloads — note the existing code already
compares against `'approved'`). **There is no "rejected" review state.** The
plan below maps `Rejected` onto *a PR that was closed without being merged*,
which is the only Github event that means "this change is not happening" and so
is the closest analogue of an Asana rejection. Reviewers with a still-pending
review subtask on a PR that gets abandoned get `Rejected` rather than today's
misleading auto-`approved`.

Alternative if that reading is wrong: drop the closed-unmerged mapping and never
emit `Rejected` at all (`changes_requested` covers every real review verdict).
That is a one-line change to the mapping table in §3 and removes step 5 of §7.
Flagging it here rather than blocking on it.

## 3. Mapping table

| Github trigger | `approval_status` written | Resulting `completed` |
| --- | --- | --- |
| `pull_request` `review_requested` (existing create/reopen path) | `pending` | `false` |
| `pull_request_review` `submitted`, `review.state === 'approved'` | `approved` | `true` |
| `pull_request_review` `submitted`, `review.state === 'changes_requested'` | `changes_requested` | `true` |
| `pull_request_review` `submitted`, `review.state === 'commented'` | *unchanged* | *unchanged* |
| `pull_request_review` `dismissed` | `pending` | `false` |
| PR closed, `merged === true` | `approved` for subtasks still pending | `true` |
| PR closed, `merged === false` | `rejected` for subtasks still pending | `true` |

Notes:

- `commented` is deliberately inert, matching today's behaviour: a drive-by
  comment is not a verdict and must not clear the reviewer's task.
- `dismissed` is new behaviour the action does not handle at all today. The
  reviewer to act on is `payload.review.user` (the author of the dismissed
  review), **not** `payload.sender` (whoever dismissed it). The existing
  `.github/workflows/asana.yml` subscribes to `pull_request_review:` with no
  `types:` filter, so these events already arrive.
- The merged case keeps today's outcome (everything completes) but now says
  `approved` explicitly rather than relying on the implicit
  `completed: true → approved` coercion.

## 4. Writing the status (the one tricky helper)

A single choke point in `src/main.ts` for every review-subtask status write:

```ts
type ReviewOutcome = 'pending' | 'approved' | 'rejected' | 'changes_requested'

/**
 * Writes a review verdict to a review subtask. With REVIEW_TASKS_AS_APPROVALS
 * off, this degrades to the plain `completed` write the action has always done.
 */
async function setReviewOutcome(
  subtask: AsanaTask,
  outcome: ReviewOutcome
): Promise<void> {
  const completed = outcome !== 'pending'
  if (!REVIEW_TASKS_AS_APPROVALS) {
    await tasksApi.updateTask({data: {completed}}, subtask.gid)
    return
  }
  const data: Record<string, unknown> = {completed, approval_status: outcome}
  // Subtasks created before this option was enabled are still `default_task`;
  // ask for the conversion on the same call. Best effort: see below.
  if (subtask.resource_subtype !== 'approval') {
    data.resource_subtype = 'approval'
  }
  try {
    await tasksApi.updateTask({data}, subtask.gid)
  } catch (err) {
    info(
      `Setting approval_status=${outcome} failed (${err}); falling back to completed=${completed}`
    )
    await tasksApi.updateTask({data: {completed}}, subtask.gid)
  }
}
```

The `try`/fallback shape mirrors the existing `html_notes` → `notes` retry in
`run()`. It is what keeps a workspace without approvals support (or a task that
refuses conversion) from breaking review sync entirely: worst case the action
behaves exactly as it does today.

`AsanaTask` gains `resource_subtype?: string`. The existing code already
re-fetches each candidate subtask with `tasksApi.getTask()` inside the
assignee-matching loop of `createOrReopenReviewSubtask`, so the full record —
and therefore `resource_subtype` — is available for the found subtask without
any extra request. Newly created subtasks come back from
`createSubtaskForTask` already carrying it.

## 5. Pure mapping module

New `src/approvals.ts`, following the shape of `src/reviewers.ts` (pure, no
Asana/Actions imports, unit-tested in isolation):

```ts
export type ReviewOutcome = 'pending' | 'approved' | 'rejected' | 'changes_requested'

/** Verdict for a submitted/dismissed Github review, or null for "no change". */
export function outcomeForReview(
  action: string,
  state: string
): ReviewOutcome | null

/** Verdict for review subtasks still open when the PR closed. */
export function outcomeForClosedPR(merged: boolean): ReviewOutcome
```

Keeping the table out of `main.ts` means the interesting logic is testable
without the module-load-time `getInput()` dance the integration harness exists
to work around.

## 6. Touch points in `src/main.ts`

1. **Flag** — alongside the other optional flags (~line 73):
   `const REVIEW_TASKS_AS_APPROVALS = getInput('REVIEW_TASKS_AS_APPROVALS') === 'true'`.
2. **`createOrReopenReviewSubtask`** — when the flag is on, add
   `resource_subtype: 'approval'` and `approval_status: 'pending'` to
   `subtaskObj`; route the reopen branch (currently
   `updateTask({data: {completed: false}})`) through `setReviewOutcome(_, 'pending')`.
   Also adjust the `html_notes` boilerplate, which currently promises "This task
   will be automatically closed when the review is completed in Github" — for
   approvals it should say the approval status is set from the Github review.
3. **`updateReviewSubTasks`, `pull_request_review` branch** — widen from
   "submitted && approved" to: compute `outcomeForReview(action, state)`, return
   early on `null`, otherwise find-or-create the reviewer's subtask and call
   `setReviewOutcome`. Note `dismissed` payloads have no `review.state` worth
   reading, so the mapping keys off `action` first.
4. **`closeSubtasks`** — takes the outcome and calls `setReviewOutcome` per
   subtask instead of blanket `completed: true`. It should skip subtasks that
   already carry a verdict (`completed === true`) so a merge does not overwrite
   a reviewer's `changes_requested` with `approved`; `getSubtasksForTask`
   returns `completed` on the compact record, so this needs no extra fetch.
5. **`run()`'s PR-closed branch** — pass `outcomeForClosedPR(payload.pull_request.merged)`
   into `closeSubtasks`, and `await` it. It is currently called without `await`
   (`src/main.ts:412`), so the subtask writes race the process exit; that is
   latent today and would become a visible flake once each subtask needs its own
   status write. Worth fixing in this change.

Nothing outside the review-subtask paths changes: the PR task itself, its "Github
Status" custom field, `NO_AUTOCLOSE_PROJECTS`, and section placement are all
untouched.

## 7. Tests

Existing suites must pass unchanged — with the flag absent, every request body
this change can emit is byte-identical to today's. That is the main regression
guard, plus:

**Unit** (`test/approvals.test.ts`): table-driven coverage of
`outcomeForReview` across `submitted`/`approved`, `submitted`/`changes_requested`,
`submitted`/`commented` → `null`, `dismissed`, plus unknown action → `null`; and
`outcomeForClosedPR` both ways.

**Integration** (`test/integration/approvals.test.ts`) using the existing
`runAction` harness and `mock-asana` helpers, all with
`inputs: {REVIEW_TASKS_AS_APPROVALS: 'true'}`. The `mockAddSubtask` /
`mockUpdateTask` matchers already receive the raw `data` body, so each case is
an assertion on the fields above:

1. `review_requested` creates a subtask with
   `resource_subtype: 'approval'`, `approval_status: 'pending'`.
2. approved review → `approval_status: 'approved'`.
3. changes-requested review → `approval_status: 'changes_requested'`
   (and `completed: true`).
4. commented review → no `updateTask` on the subtask at all
   (`scope.isDone() === false`, the pattern already used in
   `reviews.test.ts`).
5. dismissed review → `approval_status: 'pending'`, `completed: false`.
6. merged PR → pending subtasks get `approved`, already-completed ones are
   left alone.
7. closed-unmerged PR → pending subtasks get `rejected`.
8. an existing `default_task` subtask gets `resource_subtype: 'approval'`
   included in the update.
9. a rejected `approval_status` write (`mockUpdateTaskFails`, already in the
   helpers) falls back to a plain `completed` write and does not `setFailed`.

New fixtures under `test/integration/fixtures/events/`, cloned from the
existing ones:
`pull_request_review.submitted.changes_requested.json`,
`pull_request_review.submitted.commented.json`,
`pull_request_review.dismissed.json`,
`pull_request.closed.unmerged.json`.
`makeSubtask` in `fixtures/asana/factories.ts` gains an optional
`resource_subtype`.

## 8. Docs and build

- `action.yml`: new optional input, described in the style of `INCLUDE_ASSIGNEES` —
  "If `'true'`, review subtasks are created as Asana approval tasks and their
  approval status is set from the Github review verdict (Approved / Changes
  Requested / Rejected). Requires an Asana plan that supports approvals."
- `README.md`: add to the Configuration list, note the `Rejected`
  ⇄ closed-unmerged mapping explicitly since it is not obvious, and note that
  subtasks created before the option was enabled are converted on their next
  update where Asana permits it.
- `npm run all` (build, format, lint, test, package) and commit the regenerated
  `dist/` — `.github/workflows/check-dist.yml` fails the PR otherwise.

## 9. Suggested commit sequence

1. `src/approvals.ts` + `test/approvals.test.ts` (pure mapping, no behaviour change).
2. `setReviewOutcome` + `AsanaTask.resource_subtype`, with all call sites routed
   through it and the flag still off — provably no-op, existing suites green.
3. Wire the flag: creation fields, the widened `pull_request_review` branch, the
   `closeSubtasks`/`await` change.
4. Integration tests + fixtures.
5. `action.yml`, `README.md`, rebuilt `dist/`.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| Asana silently ignores `resource_subtype` on update, so pre-existing subtasks stay plain tasks | `approval_status` write is attempted anyway and falls back to `completed`; documented in the README. New subtasks are unaffected — they are born as approvals. |
| Workspace/plan does not support approvals; creation `POST` 400s | Opt-in flag, off by default. Creation is the one call **not** covered by the `setReviewOutcome` fallback — add the same try/retry-without-approval-fields shape around `createSubtaskForTask` so a rejected creation still produces a plain review subtask. |
| `changes_requested` completes the reviewer's task, so it leaves their "My Tasks" | Correct per Asana approval semantics (the reviewer has acted, and the status chip records *what* they decided). A later `review_requested` reopens it to `pending` via the existing reopen path. |
| A push (`synchronize`) reopening a decided review | Already handled: `reopenIfCompleted` is only true for the reviewer named by a `review_requested` event, so verdicts survive pushes. |
