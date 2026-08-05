import {test} from 'node:test'
import assert from 'node:assert'
import {getReviewerLogins} from '../src/reviewers'

test('getReviewerLogins', async () => {
  // Union of both groups, deduped: a person who is both assignee and requested
  // reviewer gets one task, not two.
  assert.deepEqual(
    getReviewerLogins({
      user: {login: 'author'},
      assignees: [{login: 'alice'}, {login: 'bob'}],
      requested_reviewers: [{login: 'bob'}, {login: 'carol'}]
    }),
    ['alice', 'bob', 'carol']
  )

  // The author never reviews their own PR, however they got onto the lists.
  assert.deepEqual(
    getReviewerLogins({
      user: {login: 'author'},
      assignees: [{login: 'author'}],
      requested_reviewers: [{login: 'author'}, {login: 'alice'}]
    }),
    ['alice']
  )

  // Requested teams have no login to map to an Asana user.
  assert.deepEqual(
    getReviewerLogins({
      user: {login: 'author'},
      assignees: [],
      requested_reviewers: [{name: 'a-team'}, {login: 'alice'}]
    }),
    ['alice']
  )

  assert.deepEqual(
    getReviewerLogins({
      user: {login: 'author'},
      assignees: [],
      requested_reviewers: []
    }),
    []
  )
})
