# Plan: `REVIEW_TASKS_AS_APPROVALS` — review subtasks as Asana Approvals

Implementation plan for a new opt-in action input that creates the per-reviewer
review subtasks as Asana **approval** tasks, and then drives their approval
status from the Github review verdict.

Today (`src/main.ts`) review subtasks are ordinary tasks and the only signal we
sync is `completed`: a subtask is created/reopened on `review_requested`,
completed when that reviewer approves, and all remaining subtasks are completed
when the PR closes. A reviewer looking at Asana cannot tell "I approved this"
from "I asked for changes".

Two decisions scope this down from the obvious maximal version:

- **Only three states.** `approved`, `changes_requested`, and `pending`. Github
  has no "rejected" review state, so Asana's `rejected` is never written; every
  review event that is not an approval or a changes-request converges to
  `pending`.
- **No conversion of existing tasks.** The input only affects *creation*. Once a
  subtask exists, how the action writes its verdict is decided by that subtask's
  own `resource_subtype`, not by the input. Review subtasks that predate the
  option keep their plain `completed`-only behaviour forever, and flipping the
  option back off later leaves already-created approvals working correctly.

## 1. What Asana gives us

Verified against the Asana OpenAPI spec (`Asana/openapi`, `defs/asana_oas.yaml`)
and the vendored client in `node_modules/asana`:

- `TaskCompact.resource_subtype` accepts `default_task | milestone | approval |
  custom`, and is part of the *compact* representation — so it comes back from
  `getSubtasksForTask` without needing the full record.
- `TaskBase.approval_status` accepts `pending | approved | rejected |
  changes_requested`, with this description:

  > *Conditional* Reflects the approval status of this task. This field is kept
  > in sync with `completed`, meaning `pending` translates to false while
  > `approved`, `rejected`, and `changes_requested` translate to true. If you
  > set completed to true, this field will be set to `approved`.

- Both fields are reachable from `TaskCreateRequest` (`allOf` → `TaskRequestBase`
  → `TaskBase` → `TaskCompact`), and `POST /tasks/{task_gid}/subtasks` takes a
  `TaskCreateRequest` — so we can set them on the subtask-creation call the
  action already makes.
- The `asana` npm client passes request bodies straight through
  (`createTaskWithHttpInfo`/`createSubtaskForTaskWithHttpInfo` do
  `var postBody = body`), so no client-side field whitelist blocks these; the
  existing `nock`-level integration mocks will see them verbatim.

The consequence that shapes everything below: **`completed` and
`approval_status` are the same piece of state.** Setting
`approval_status: 'changes_requested'` *completes* the subtask, and setting
`completed: true` silently means `approved`. So every place the current code
writes `completed` on a review subtask has to become subtype-aware.

## 2. Mapping table

Github webhook review states are lowercase — `approved`, `changes_requested`,
`commented`, `dismissed` (the existing code already compares against
`'approved'`).

| Github trigger | `approval_status` on an approval subtask | `completed` |
| --- | --- | --- |
| `pull_request` `review_requested` (existing create/reopen path) | `pending` | `false` |
| `pull_request_review` `submitted`, `review.state === 'approved'` | `approved` | `true` |
| `pull_request_review` `submitted`, `review.state === 'changes_requested'` | `changes_requested` | `true` |
| `pull_request_review` `submitted`, `review.state === 'commented'` | `pending` | `false` |
| `pull_request_review` `dismissed` | `pending` | `false` |
| PR closed (merged or not) | `approved` (forced by Asana, see below) | `true` |

Notes on the two rows worth arguing about:

- **`commented` → `pending`** follows "other states converge to pending"
  literally, and it is a behaviour change beyond just approvals: today a
  `commented` review is completely inert. Under this table, a reviewer who
  approves and *later* posts a comment-review has their subtask reopened. That
  cuts against the intent recorded in `updateReviewSubTasks` ("Everyone else
  keeps the verdict they already gave, so that a later push does not reopen a
  review that has been given"). If that reopen is unwanted, the mapping function
  returns `null` for `commented` instead of `'pending'` — a one-line change,
  isolated in `src/approvals.ts` by design.
- **PR closed** cannot be neutral. There is no way to complete an approval task
  without Asana coercing its status to `approved` ("If you set completed to true,
  this field will be set to `approved`"). Since we are not writing `rejected`,
  an abandoned PR will leave its outstanding review approvals reading
  "Approved". This is exactly today's behaviour (everything gets completed), just
  now with a visible — and slightly wrong — status chip. The alternative is
  leaving reviewers with open tasks on dead PRs, which is worse. Called out in
  the README rather than worked around.

`dismissed` is new behaviour the action does not handle at all today. The
reviewer to act on is `payload.review.user` (the author of the dismissed
review), **not** `payload.sender` (whoever dismissed it). The existing
`.github/workflows/asana.yml` subscribes to `pull_request_review:` with no
`types:` filter, so these events already arrive.

## 3. Creation: the only thing the input controls

In `createOrReopenReviewSubtask`, when `REVIEW_TASKS_AS_APPROVALS` is set, the
new-subtask body gains `resource_subtype: 'approval'` and
`approval_status: 'pending'`. Approvals may require a paid Asana plan, so
creation retries once without those fields if Asana rejects the request —
mirroring the existing `html_notes` → `notes` retry in `run()`, and keeping a
workspace without approvals support from losing review sync entirely:

```ts
async function createReviewSubtask(
  taskId: string,
  subtaskObj: Record<string, unknown>
): Promise<AsanaTask> {
  if (!REVIEW_TASKS_AS_APPROVALS) {
    return (await tasksApi.createSubtaskForTask({data: subtaskObj}, taskId)).data
  }
  try {
    return (
      await tasksApi.createSubtaskForTask(
        {data: {...subtaskObj, resource_subtype: 'approval', approval_status: 'pending'}},
        taskId
      )
    ).data
  } catch (err) {
    info(`Creating an approval subtask failed (${err}); creating a plain task`)
    return (await tasksApi.createSubtaskForTask({data: subtaskObj}, taskId)).data
  }
}
```

The subtask's `html_notes` boilerplate also needs a second wording: it currently
promises "This task will be automatically closed when the review is completed in
Github", which for an approval should say the approval status is set from the
Github review.

## 4. Writes: driven by the subtask, not the input

One choke point for every review-subtask status write. It branches on the
subtask's own subtype, so a mixed project — old plain subtasks alongside new
approvals — is handled correctly with no migration:

```ts
type ReviewOutcome = 'pending' | 'approved' | 'changes_requested'

async function setReviewOutcome(
  subtask: AsanaTask,
  outcome: ReviewOutcome
): Promise<void> {
  const completed = outcome !== 'pending'
  const data =
    subtask.resource_subtype === 'approval'
      ? {completed, approval_status: outcome}
      : {completed}
  await tasksApi.updateTask({data}, subtask.gid)
}
```

`AsanaTask` gains `resource_subtype?: string`. Every subtask the action writes to
must therefore carry it:

- Subtasks found by the assignee-matching loop in `createOrReopenReviewSubtask`
  are already re-fetched with `tasksApi.getTask()`, so the full record has it.
- Newly created ones come back from `createSubtaskForTask` carrying it.
- `closeSubtasks` writes to subtasks it never fetches individually. It reads
  `getSubtasksForTask`, whose compact records include `resource_subtype` — but
  since the branch's correctness depends on it, pass it explicitly:
  `getSubtasksForTask(taskId, {opt_fields: 'resource_subtype,completed'})`.
  (`mockSubtasks` matches with `.query(true)`, so the integration mocks need no
  change.)

## 5. Pure mapping module

New `src/approvals.ts`, following the shape of `src/reviewers.ts` (pure, no
Asana/Actions imports, unit-tested in isolation):

```ts
export type ReviewOutcome = 'pending' | 'approved' | 'changes_requested'

/**
 * Verdict for a `pull_request_review` event: `approved` and
 * `changes_requested` reviews carry their own verdict, anything else
 * (`commented`, `dismissed`) puts the review back to `pending`.
 */
export function outcomeForReview(action: string, state?: string): ReviewOutcome
```

Keeping the table out of `main.ts` means the interesting logic is testable
without the module-load-time `getInput()` dance the integration harness exists
to work around, and makes the `commented` question from §2 a one-line edit.

## 6. Touch points in `src/main.ts`

1. **Flag** — alongside the other optional flags (~line 73):
   `const REVIEW_TASKS_AS_APPROVALS = getInput('REVIEW_TASKS_AS_APPROVALS') === 'true'`.
2. **`createOrReopenReviewSubtask`** — create via `createReviewSubtask` (§3);
   route the reopen branch (currently `updateTask({data: {completed: false}})`)
   through `setReviewOutcome(_, 'pending')`; add the approvals wording to
   `html_notes`.
3. **`updateReviewSubTasks`, `pull_request_review` branch** — widen from
   "submitted && approved" to: compute `outcomeForReview(action, review.state)`,
   find-or-create the reviewer's subtask, call `setReviewOutcome`. Note that
   `dismissed` payloads have no meaningful `review.state`, so the mapping keys
   off `action` first. The existing find-or-create call already reopens a
   completed subtask before we write the real verdict; that redundant write is
   harmless and stays as-is.
4. **`closeSubtasks`** — call `setReviewOutcome(subtask, 'approved')` per subtask
   instead of a blanket `completed: true`, and skip subtasks that already have a
   verdict (`completed === true`) so a merge does not overwrite someone's
   `changes_requested`.
5. **`run()`'s PR-closed branch** — `await closeSubtasks(taskId)`. It is
   currently called without `await` (`src/main.ts:412`), so its writes race the
   process exit; latent today, a visible flake once each subtask needs its own
   status write. Worth fixing here.

Nothing outside the review-subtask paths changes: the PR task itself, its "Github
Status" custom field, `NO_AUTOCLOSE_PROJECTS`, and section placement are all
untouched.

## 7. Tests

Existing suites must pass unchanged — with the input absent, every request body
this change emits is byte-identical to today's. That is the main regression
guard, plus:

**Unit** (`test/approvals.test.ts`): table-driven coverage of `outcomeForReview`
over `submitted`/`approved`, `submitted`/`changes_requested`,
`submitted`/`commented`, `dismissed`, and an unknown action.

**Integration** (`test/integration/approvals.test.ts`) using the existing
`runAction` harness and `mock-asana` helpers, all with
`inputs: {REVIEW_TASKS_AS_APPROVALS: 'true'}`. The `mockAddSubtask` /
`mockUpdateTask` matchers already receive the raw `data` body, so each case is an
assertion on the fields above:

1. `review_requested` creates a subtask with `resource_subtype: 'approval'`
   and `approval_status: 'pending'`.
2. approved review on an approval subtask → `approval_status: 'approved'`.
3. changes-requested review → `approval_status: 'changes_requested'`,
   `completed: true`.
4. commented review → `approval_status: 'pending'`, `completed: false`.
5. dismissed review → `approval_status: 'pending'`, `completed: false`.
6. **mixed project**: an existing `default_task` review subtask gets a
   `completed`-only update with **no** `approval_status` and **no**
   `resource_subtype`, even with the input on — the no-conversion guarantee.
7. closed PR → pending approval subtasks get `completed: true`,
   already-completed ones are left alone.
8. creation rejected by Asana (`nock` 400 on the first `POST`) falls back to
   creating a plain subtask and does not `setFailed`.

New fixtures under `test/integration/fixtures/events/`, cloned from the existing
ones: `pull_request_review.submitted.changes_requested.json`,
`pull_request_review.submitted.commented.json`,
`pull_request_review.dismissed.json`. `makeSubtask` in
`fixtures/asana/factories.ts` gains an optional `resource_subtype`, defaulting to
`'default_task'` so case 6 is the default shape.

`mock-asana.ts` needs one small addition — a `mockAddSubtaskFails` alongside the
existing `mockUpdateTaskFails` — for case 8.

## 8. Docs and build

- `action.yml`: new optional input, described in the style of `INCLUDE_ASSIGNEES` —
  "If `'true'`, newly created review subtasks are Asana approval tasks whose
  approval status is set from the Github review (Approved / Changes Requested /
  pending). Requires an Asana plan that supports approvals. Review subtasks
  created before this was enabled are unaffected."
- `README.md`: add to the Configuration list; state that existing review
  subtasks are never converted, that Github's lack of a "rejected" review means
  Asana's `Rejected` status is never used, and that closing a PR completes
  outstanding approvals as `Approved` because Asana does not allow completing an
  approval any other way.
- `npm run all` (build, format, lint, test, package) and commit the regenerated
  `dist/` — `.github/workflows/check-dist.yml` fails the PR otherwise.

## 9. Suggested commit sequence

1. `src/approvals.ts` + `test/approvals.test.ts` (pure mapping, unreferenced —
   no behaviour change).
2. `setReviewOutcome` + `AsanaTask.resource_subtype` + the `opt_fields` on
   `getSubtasksForTask`, with all existing call sites routed through it. Provably
   a no-op while no approvals exist; existing suites green.
3. Wire the input: `createReviewSubtask`, the widened `pull_request_review`
   branch, the `closeSubtasks`/`await` change.
4. Integration tests + fixtures + `mockAddSubtaskFails`.
5. `action.yml`, `README.md`, rebuilt `dist/`.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| Workspace/plan does not support approvals; creation `POST` fails | Retry without the approval fields (§3), so review sync degrades to today's behaviour rather than breaking. Covered by test case 8. |
| A subtype branch reads a missing `resource_subtype` and writes `completed` only | Explicit `opt_fields` on `getSubtasksForTask`; the other two sources are full records. Worst case is today's behaviour, not a wrong status. |
| `commented` reviews reopening a verdict already given | Flagged as an open question in §2; one-line reversal in `src/approvals.ts`. |
| `changes_requested` completes the reviewer's task, so it leaves their "My Tasks" | Correct per Asana approval semantics — the reviewer has acted, and the status records *what* they decided. A later `review_requested` reopens it to `pending` via the existing reopen path. |
| A push (`synchronize`) reopening a decided review | Already handled: `reopenIfCompleted` is only true for the reviewer named by a `review_requested` event, so verdicts survive pushes. |
