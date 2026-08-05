type ReviewerSources = {
  user: {login: string}
  assignees: {login: string}[]
  requested_reviewers: ({login: string} | {name: string})[]
}

/**
 * Logins that should get a review subtask: the union of the PR's assignees and
 * its requested reviewers, minus the author (a self-assigned PR is not a review
 * request). Requested teams are skipped, as they have no login to look up in
 * USER_MAP.
 *
 * This is derived from the PR's current state rather than from the triggering
 * event, so reviewers requested in the same burst all get a task even if
 * Github's concurrency queue dropped some of the webhooks.
 */
export function getReviewerLogins(pr: ReviewerSources): string[] {
  const logins = [
    ...pr.assignees.map(assignee => assignee.login),
    ...pr.requested_reviewers.flatMap(reviewer =>
      'login' in reviewer ? [reviewer.login] : []
    )
  ]
  return [...new Set(logins)].filter(login => login !== pr.user.login)
}
