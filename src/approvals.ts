/**
 * The approval status a review task can be left in. Github has no "rejected"
 * review state, so Asana's `rejected` status is never used.
 */
export type ReviewOutcome = 'pending' | 'approved' | 'changes_requested'

/**
 * The outcome a `pull_request_review` event should record for the review's
 * author. An `approved` or `changes_requested` review carries its own verdict;
 * anything else - a `commented` review, or a review that was dismissed - leaves
 * the review outstanding, so it converges to `pending`.
 *
 * A review can be `edited` after the fact, in which case the payload still
 * carries the verdict it was edited into, so it is mapped the same way as a
 * freshly submitted one.
 */
export function outcomeForReview(
  action: string,
  state?: string
): ReviewOutcome {
  if (action !== 'submitted' && action !== 'edited') {
    // `dismissed`, or an action Github adds later: no verdict to read.
    return 'pending'
  }
  switch (state) {
    case 'approved':
      return 'approved'
    case 'changes_requested':
      return 'changes_requested'
    default:
      return 'pending'
  }
}
