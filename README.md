# Asana sync action

This is a Github Action for tracking the status of Github Pull requests in Asana. It does the following:

1.  Creates tasks for each new pull request in a project.
2.  Puts these tasks in a specified Asana project (and optionally section)
3.  Makes the PR task as a subtask of Asana task referenced in PR description
4.  Syncs any change to the PR name to Asana.
5.  Syncs the PR state (Open, Closed, Draft, Merged) to an Asana custom field.
6.  Creates a subtask for each requested review and automatically resolves these once approved or merged

## Usage

Create a [workflow file](./.github/workflows/asana.yml) that runs on
`pull_request` and `pull_request_review` events:

```yml
name: 'asana sync'
on:
  pull_request_review:
  pull_request:
    types:
      - opened
      - edited
      - closed
      - reopened
      - synchronize
      - review_requested

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: duckduckgo/action-asana-sync@v1
        with:
          ASANA_ACCESS_TOKEN: ${{ secrets.ASANA_ACCESS_TOKEN }}
          ASANA_WORKSPACE_ID: ${{ secrets.ASANA_WORKSPACE_ID }}
          ASANA_PROJECT_ID: 'GID of project to create the tasks in'
```

## Configuration

There are a few additional configuration options that can be used to tweak
behaviour of this Github Action:

- `NO_AUTOCLOSE_PROJECTS`: By default this action will automatically close PR
  task it opens. It will not close merged tasks when they are added to projects
  listed in this variable (comma separated string of IDs). (default: REVIEW/RELEASE project)
- `SKIPPED_USERS`: Some users don't like receiving reviews in Asana. This is a
  comma separated list of github usernames that will be ignored (replaced with
  dax).
- `REVIEW_TASKS_AS_APPROVALS`: Set this to `'true'` to create review subtasks as
  Asana **approval** tasks, so the reviewer's verdict is visible in Asana rather
  than just "done". An approving review sets the task to *Approved*, a
  changes-requested review to *Changes Requested*, and a commented or dismissed
  review puts it back to pending. Requires an Asana plan that supports
  approvals; if Asana rejects the approval task, the action falls back to
  creating a plain one. Some details worth knowing:
  - Only *new* subtasks are affected. Review subtasks created before this was
    enabled are never converted, and keep behaving as they always have (an
    approval closes them, nothing else does). How each subtask is updated
    follows that subtask's own type, so mixed projects are fine and turning the
    option back off does not break approvals already created.
  - Asana's *Rejected* status is never used, as Github has no equivalent review
    state.
  - Asana ties an approval's status to its completion: a task cannot be
    completed without becoming *Approved*. So closing a PR marks any review
    that had not yet been given as *Approved*, rather than leaving reviewers
    with open tasks on a dead PR.
- `INCLUDE_ASSIGNEES`: By default a review subtask is only created for users
  added to the PR's *Reviewers*. Set this to `'true'` to create one for the
  union of *Reviewers* and *Assignees* instead, minus the PR author. Useful for
  teams that drive code review from the Assignees field. Note that with this
  enabled the reviewer set is read from the PR's current state on every event
  rather than from the triggering webhook.


## Tests

Run the whole suite with `npm test`. It's split into two Jest projects:

- **unit** (`test/*.test.ts`): small, focused tests, e.g. `user-map.test.ts`
  covers `getUserFromLogin` against a mocked Github API (via undici's
  `MockAgent`, since Octokit talks fetch rather than plain `http`), and
  `reviewers.test.ts` covers `getReviewerLogins`'s pure set logic.
- **integration** (`test/integration/**`): drives the real action entrypoint
  (`src/main.ts`) end-to-end for each Github event it handles (PR opened,
  updated, closed/merged, review requested, review approved), against a
  mocked Asana API. Mocking is done with `nock` at the HTTP boundary
  (`https://app.asana.com`), so the real `asana` client's request/response
  handling is exercised, not a hand-rolled stub of it. See
  `test/integration/helpers/harness.ts` and
  `test/integration/helpers/mock-asana.ts`.

Run just one project with `npm run test:unit` or `npm run test:integration`.

No live API keys are needed to run any of these tests.
