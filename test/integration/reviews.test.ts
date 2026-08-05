import fs from 'fs'
import path from 'path'
import {runAction} from './helpers/harness'
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

const CUSTOM_FIELDS = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures/asana/custom-fields.json'),
    'utf8'
  )
)
const REVIEW_REQUESTED_EVENT = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures/events/pull_request.review_requested.json'),
    'utf8'
  )
)
const REVIEW_APPROVED_EVENT = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      'fixtures/events/pull_request_review.submitted.approved.json'
    ),
    'utf8'
  )
)

const WORKSPACE_ID = '1000'

/**
 * updateReviewSubTasks() calls createOrReopenReviewSubtask() without
 * awaiting it on the review_requested path, so the subtask HTTP call can
 * still be in flight when runAction()'s underlying run() resolves. Give
 * pending microtasks a couple of turns to settle before asserting on it.
 */
async function flushBackgroundWork(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 200))
}

describe('review requested', () => {
  const taskGid = '8000'

  function mockBaseTaskLookup(): void {
    mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
    mockSearchTasksInWorkspace(WORKSPACE_ID, [makeTask({gid: taskGid})])
    mockUpdateTask(taskGid, () => true)
  }

  it('creates a review subtask for a mapped, non-skipped reviewer', async () => {
    mockBaseTaskLookup()
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
    await flushBackgroundWork()

    expect(setFailed).not.toHaveBeenCalled()
    expect(addSubtaskScope.isDone()).toBe(true)
  })

  it('does not create a subtask for a reviewer in SKIPPED_USERS', async () => {
    mockBaseTaskLookup()
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
      inputs: {
        SKIPPED_USERS: 'reviewer-bot',
        USER_MAP: JSON.stringify({'reviewer-bot': 'reviewer@example.com'})
      }
    })
    await flushBackgroundWork()

    expect(addSubtaskScope.isDone()).toBe(false)
  })

  it('does not create a subtask for an unmapped reviewer', async () => {
    mockBaseTaskLookup()
    mockSubtasks(taskGid, [])
    const addSubtaskScope = mockAddSubtask(
      taskGid,
      () => true,
      makeSubtask({gid: '8003'})
    )

    await runAction({
      eventName: 'pull_request',
      payload: REVIEW_REQUESTED_EVENT,
      inputs: {USER_MAP: '{}'}
    })
    await flushBackgroundWork()

    expect(addSubtaskScope.isDone()).toBe(false)
  })

  it('reopens an existing review subtask instead of creating a new one', async () => {
    mockBaseTaskLookup()
    const existingSubtask = makeSubtask({
      gid: '8004',
      assignee: {gid: '9500'}
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
    await flushBackgroundWork()

    expect(reopenScope.isDone()).toBe(true)
    expect(addSubtaskScope.isDone()).toBe(false)
  })
})

describe('review approved', () => {
  const taskGid = '8100'

  it('marks the matching review subtask as completed', async () => {
    mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
    mockSearchTasksInWorkspace(WORKSPACE_ID, [makeTask({gid: taskGid})])
    mockUpdateTask(taskGid, () => true)
    const existingSubtask = makeSubtask({
      gid: '8101',
      assignee: {gid: '9600'}
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
    mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
    mockSearchTasksInWorkspace(WORKSPACE_ID, [makeTask({gid: taskGid})])
    mockUpdateTask(taskGid, () => true)
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
