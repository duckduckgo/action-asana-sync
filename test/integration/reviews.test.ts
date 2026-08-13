import {runAction, loadFixture} from './helpers/harness'
import {
  mockSubtasks,
  mockAddSubtask,
  mockExistingReviewSubtask,
  mockPRTaskLookup,
  mockUpdateTask,
  mockUpdateTaskNeverCalled
} from './helpers/mock-asana'
import {makeSubtask} from './fixtures/asana/factories'
import './setup'

const CUSTOM_FIELDS = loadFixture('fixtures/asana/custom-fields.json')
const REVIEW_REQUESTED_EVENT = loadFixture(
  'fixtures/events/pull_request.review_requested.json'
)
const REVIEW_APPROVED_EVENT = loadFixture(
  'fixtures/events/pull_request_review.submitted.approved.json'
)

describe('review requested', () => {
  const taskGid = '8000'

  it('creates a review subtask for a mapped, non-skipped reviewer', async () => {
    mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
    mockSubtasks(taskGid, [])
    const addSubtaskScope = mockAddSubtask(
      taskGid,
      data => {
        expect(data.assignee).toBe('reviewer@example.com')
        expect(data.name).toContain('Review Request')
        return true
      },
      makeSubtask({gid: '8001'})
    )

    const {setFailed} = await runAction({
      eventName: 'pull_request',
      payload: REVIEW_REQUESTED_EVENT,
      inputs: {
        USER_MAP: JSON.stringify({'reviewer-bot': 'reviewer@example.com'})
      }
    })
    expect(setFailed).not.toHaveBeenCalled()
    expect(addSubtaskScope.isDone()).toBe(true)
  })

  const skippedOrUnmappedCases: {
    description: string
    inputs: Record<string, string>
  }[] = [
    {
      description: 'a reviewer in SKIPPED_USERS',
      inputs: {
        SKIPPED_USERS: 'reviewer-bot',
        USER_MAP: JSON.stringify({'reviewer-bot': 'reviewer@example.com'})
      }
    },
    {
      description: 'an unmapped reviewer',
      inputs: {USER_MAP: '{}'}
    }
  ]

  it.each(skippedOrUnmappedCases)(
    'does not create a subtask for $description',
    async ({inputs}) => {
      mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
      mockSubtasks(taskGid, [])
      // Consumed only if a subtask is created, which it should not be.
      const addSubtaskScope = mockAddSubtask(
        taskGid,
        () => true,
        makeSubtask({gid: '8002'})
      )

      await runAction({
        eventName: 'pull_request',
        payload: REVIEW_REQUESTED_EVENT,
        inputs
      })
      expect(addSubtaskScope.isDone()).toBe(false)
    }
  )

  it('reopens an existing, completed review subtask instead of creating a new one', async () => {
    mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
    mockExistingReviewSubtask(taskGid, {
      subtaskGid: '8004',
      userGid: '9500',
      completed: true
    })
    const reopenScope = mockUpdateTask('8004', data => {
      expect(data.completed).toBe(false)
      return true
    })
    const addSubtaskScope = mockAddSubtask(
      taskGid,
      () => true,
      makeSubtask({gid: '8005'})
    )

    await runAction({
      eventName: 'pull_request',
      payload: REVIEW_REQUESTED_EVENT,
      inputs: {
        USER_MAP: JSON.stringify({'reviewer-bot': 'reviewer@example.com'})
      }
    })
    expect(reopenScope.isDone()).toBe(true)
    expect(addSubtaskScope.isDone()).toBe(false)
  })

  it('leaves an already-open review subtask alone (no reopen, no new task)', async () => {
    mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
    mockExistingReviewSubtask(taskGid, {
      subtaskGid: '8006',
      userGid: '9501',
      completed: false
    })
    const reopenScope = mockUpdateTaskNeverCalled('8006')
    const addSubtaskScope = mockAddSubtask(
      taskGid,
      () => true,
      makeSubtask({gid: '8007'})
    )

    await runAction({
      eventName: 'pull_request',
      payload: REVIEW_REQUESTED_EVENT,
      inputs: {
        USER_MAP: JSON.stringify({'reviewer-bot': 'reviewer@example.com'})
      }
    })
    expect(reopenScope.isDone()).toBe(false)
    expect(addSubtaskScope.isDone()).toBe(false)
  })

  it('with INCLUDE_ASSIGNEES: creates subtasks for the union of assignees and requested reviewers, minus the author', async () => {
    mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
    mockSubtasks(taskGid, [])
    // getReviewerLogins() reads assignees/requested_reviewers off the PR's
    // current state, not off the webhook's own requested_reviewer field.
    const payload = {
      ...REVIEW_REQUESTED_EVENT,
      pull_request: {
        ...REVIEW_REQUESTED_EVENT.pull_request,
        assignees: [{login: 'alice'}],
        requested_reviewers: [{login: 'reviewer-bot'}]
      }
    }
    const aliceSubtask = mockAddSubtask(
      taskGid,
      data => {
        expect(data.assignee).toBe('alice@example.com')
        return true
      },
      makeSubtask({gid: '8008'})
    )
    const reviewerBotSubtask = mockAddSubtask(
      taskGid,
      data => {
        expect(data.assignee).toBe('reviewer@example.com')
        return true
      },
      makeSubtask({gid: '8009'})
    )

    const {setFailed} = await runAction({
      eventName: 'pull_request',
      payload,
      inputs: {
        INCLUDE_ASSIGNEES: 'true',
        USER_MAP: JSON.stringify({
          alice: 'alice@example.com',
          'reviewer-bot': 'reviewer@example.com'
        })
      }
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(aliceSubtask.isDone()).toBe(true)
    expect(reviewerBotSubtask.isDone()).toBe(true)
  })
})

describe('review approved', () => {
  const taskGid = '8100'

  it('marks the matching review subtask as completed', async () => {
    mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
    mockExistingReviewSubtask(taskGid, {
      subtaskGid: '8101',
      userGid: '9600',
      completed: true
    })
    const completeScope = mockUpdateTask('8101', data => {
      expect(data.completed).toBe(true)
      return true
    })
    // The verdict is written directly, without reopening the task first.
    const extraWriteScope = mockUpdateTaskNeverCalled('8101')

    const {setFailed} = await runAction({
      eventName: 'pull_request_review',
      payload: REVIEW_APPROVED_EVENT,
      inputs: {
        USER_MAP: JSON.stringify({'reviewer-bot': 'reviewer@example.com'})
      }
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(completeScope.isDone()).toBe(true)
    expect(extraWriteScope.isDone()).toBe(false)
  })

  it('creates and immediately completes a subtask if none existed yet', async () => {
    mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
    mockSubtasks(taskGid, [])
    const createdSubtask = makeSubtask({gid: '8102'})
    mockAddSubtask(taskGid, () => true, createdSubtask)
    const completeScope = mockUpdateTask('8102', data => {
      expect(data.completed).toBe(true)
      return true
    })

    await runAction({
      eventName: 'pull_request_review',
      payload: REVIEW_APPROVED_EVENT,
      inputs: {
        USER_MAP: JSON.stringify({'reviewer-bot': 'reviewer@example.com'})
      }
    })

    expect(completeScope.isDone()).toBe(true)
  })

  it('matches the right subtask among several from the listing alone, with no per-subtask lookups', async () => {
    // Neither subtask's gid/assignee is fetched individually: nock has no
    // interceptors registered for /tasks/{gid} or /users/{gid} here, so the
    // action must be matching purely off what getSubtasksForTask returned.
    mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
    const otherSubtask = makeSubtask({
      gid: '8103',
      assignee: {gid: '9601', email: 'someone-else@example.com'},
      completed: true
    })
    const reviewerSubtask = makeSubtask({
      gid: '8104',
      assignee: {gid: '9602', email: 'reviewer@example.com'},
      completed: true
    })
    mockSubtasks(taskGid, [otherSubtask, reviewerSubtask])
    const completeScope = mockUpdateTask('8104', data => {
      expect(data.completed).toBe(true)
      return true
    })
    const wrongScope = mockUpdateTaskNeverCalled('8103')

    const {setFailed} = await runAction({
      eventName: 'pull_request_review',
      payload: REVIEW_APPROVED_EVENT,
      inputs: {
        USER_MAP: JSON.stringify({'reviewer-bot': 'reviewer@example.com'})
      }
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(completeScope.isDone()).toBe(true)
    expect(wrongScope.isDone()).toBe(false)
  })
})
