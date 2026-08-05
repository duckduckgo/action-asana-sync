import {getReviewerLogins} from '../src/reviewers'

describe('getReviewerLogins', () => {
  it('unions assignees and requested reviewers, deduped', () => {
    // A person who is both assignee and requested reviewer gets one task,
    // not two.
    expect(
      getReviewerLogins({
        user: {login: 'author'},
        assignees: [{login: 'alice'}, {login: 'bob'}],
        requested_reviewers: [{login: 'bob'}, {login: 'carol'}]
      })
    ).toEqual(['alice', 'bob', 'carol'])
  })

  it('excludes the PR author, however they got onto the lists', () => {
    expect(
      getReviewerLogins({
        user: {login: 'author'},
        assignees: [{login: 'author'}],
        requested_reviewers: [{login: 'author'}, {login: 'alice'}]
      })
    ).toEqual(['alice'])
  })

  it('skips requested teams, which have no login to map to an Asana user', () => {
    expect(
      getReviewerLogins({
        user: {login: 'author'},
        assignees: [],
        requested_reviewers: [{name: 'a-team'}, {login: 'alice'}]
      })
    ).toEqual(['alice'])
  })

  it('returns an empty list when there are no assignees or reviewers', () => {
    expect(
      getReviewerLogins({
        user: {login: 'author'},
        assignees: [],
        requested_reviewers: []
      })
    ).toEqual([])
  })
})
