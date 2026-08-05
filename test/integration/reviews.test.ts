import {runAction, loadFixture} from './helpers/harness'
import {
  mockCustomFields,
  mockSearchTasksInWorkspace,
  mockSubtasks,
  mockAddSubtask,
  mockFindTaskById,
  mockFindUserById,
  mockUpdateTask
} from './helpers/mock-asana'
import {makeTask, makeSubtask, makeUser} from './fixtures/asana/factories'
import './setup'

const CUSTOM_FIELDS = loadFixture('fixtures/asana/custom-fields.json')
const REVIEW_REQUESTED_EVENT = loadFixture(
  'fixtures/events/pull_request.review_requested.json'
)
const REVIEW_APPROVED_EVENT = loadFixture(
  'fixtures/events/pull_request_review.submitted.approved.json'
)

const WORKSPACE_ID = '1000'

/** Mocks the lookup+update of the PR's own Asana task, shared by every case below. */
function mockBaseTaskLookup(taskGid: string): void {
  mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
  mockSearchTasksInWorkspace(WORKSPACE_ID, [makeTask({gid: taskGid})])
  mockUpdateTask(taskGid, () => true)
}

describe('review requested', () => {
  const taskGid = '8000'

  it('creates a review subtask for a mapped, non-skipped reviewer', async () => {
    mockBaseTaskLookup(taskGid)
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
      mockBaseTaskLookup(taskGid)
      mockSubtasks(taskGid, [])
      // Registered so an unexpected call succeeds instead of tripping
      // disableNetConnect; the assertion is that it's never consumed.
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
    mockBaseTaskLookup(taskGid)
    const existingSubtask = makeSubtask({
      gid: '8004',
      assignee: {gid: '9500'},
      completed: true
    })
    mockSubtasks(taskGid, [existingSubtask])
    mockFindTaskById('8004', existingSubtask)
    mockFindUserById(
      '9500',
      makeUser({gid: '9500', email: 'reviewer@example.com'})
    )
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
    mockBaseTaskLookup(taskGid)
    const existingSubtask = makeSubtask({
      gid: '8006',
      assignee: {gid: '9501'},
      completed: false
    })
    mockSubtasks(taskGid, [existingSubtask])
    mockFindTaskById('8006', existingSubtask)
    mockFindUserById(
      '9501',
      makeUser({gid: '9501', email: 'reviewer@example.com'})
    )
    // Registered so an unexpected call succeeds instead of tripping
    // disableNetConnect; the assertions are that neither is ever consumed.
    const reopenScope = mockUpdateTask('8006', () => true)
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
    mockBaseTaskLookup(taskGid)
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
    mockBaseTaskLookup(taskGid)
    const existingSubtask = makeSubtask({
      gid: '8101',
      assignee: {gid: '9600'},
      completed: true
    })
    mockSubtasks(taskGid, [existingSubtask])
    mockFindTaskById('8101', existingSubtask)
    mockFindUserById(
      '9600',
      makeUser({gid: '9600', email: 'reviewer@example.com'})
    )
    const reopenScope = mockUpdateTask('8101', data => {
      expect(data.completed).toBe(false)
      return true
    })
    const completeScope = mockUpdateTask('8101', data => {
      expect(data.completed).toBe(true)
      return true
    })

    const {setFailed} = await runAction({
      eventName: 'pull_request_review',
      payload: REVIEW_APPROVED_EVENT,
      inputs: {
        USER_MAP: JSON.stringify({'reviewer-bot': 'reviewer@example.com'})
      }
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(reopenScope.isDone()).toBe(true)
    expect(completeScope.isDone()).toBe(true)
  })

  it('creates and immediately completes a subtask if none existed yet', async () => {
    mockBaseTaskLookup(taskGid)
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
})
