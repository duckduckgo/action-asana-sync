import {outcomeForReview, ReviewOutcome} from '../src/approvals.js'

describe('outcomeForReview', () => {
  const cases: {action: string; state?: string; expected: ReviewOutcome}[] = [
    {action: 'submitted', state: 'approved', expected: 'approved'},
    {
      action: 'submitted',
      state: 'changes_requested',
      expected: 'changes_requested'
    },
    // A comment is not a verdict, so the review stays outstanding.
    {action: 'submitted', state: 'commented', expected: 'pending'},
    // An edited review still carries the verdict it was edited into.
    {action: 'edited', state: 'approved', expected: 'approved'},
    {
      action: 'edited',
      state: 'changes_requested',
      expected: 'changes_requested'
    },
    // A dismissed review's state is not a verdict we can act on.
    {action: 'dismissed', state: 'dismissed', expected: 'pending'},
    {action: 'dismissed', state: 'approved', expected: 'pending'},
    // Anything Github adds later, and a payload with no state at all.
    {action: 'some_future_action', state: 'approved', expected: 'pending'},
    {action: 'submitted', expected: 'pending'}
  ]

  it.each(cases)(
    'maps $action/$state to $expected',
    ({action, state, expected}) => {
      expect(outcomeForReview(action, state)).toBe(expected)
    }
  )
})
