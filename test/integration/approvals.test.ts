import {runAction, loadFixture} from './helpers/harness'
import {
  mockCustomFields,
  mockSearchTasksInWorkspace,
  mockSubtasks,
  mockAddSubtask,
  mockAddSubtaskFails,
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
const APPROVED_EVENT = loadFixture(
  'fixtures/events/pull_request_review.submitted.approved.json'
)
const CHANGES_REQUESTED_EVENT = loadFixture(
  'fixtures/events/pull_request_review.submitted.changes_requested.json'
)
const COMMENTED_EVENT = loadFixture(
  'fixtures/events/pull_request_review.submitted.commented.json'
)
const DISMISSED_EVENT = loadFixture(
  'fixtures/events/pull_request_review.dismissed.json'
)
const CLOSED_EVENT = loadFixture(
  'fixtures/events/pull_request.closed.merged.json'
)

const WORKSPACE_ID = '1000'
const USER_MAP = JSON.stringify({'reviewer-bot': 'reviewer@example.com'})
const APPROVALS_ON = {REVIEW_TASKS_AS_APPROVALS: 'true', USER_MAP}

/** Mocks the lookup+update of the PR's own Asana task, shared by every case below. */
function mockBaseTaskLookup(taskGid: string): void {
  mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
  mockSearchTasksInWorkspace(WORKSPACE_ID, [makeTask({gid: taskGid})])
  mockUpdateTask(taskGid, () => true)
}

/**
 * Mocks an existing review subtask assigned to reviewer-bot, wiring up the
 * lookups createOrReopenReviewSubtask() makes to match it to that reviewer.
 */
function mockExistingReviewSubtask(
  taskGid: string,
  subtaskGid: string,
  userGid: string,
  overrides: Record<string, unknown>
): void {
  const subtask = makeSubtask({
    gid: subtaskGid,
    assignee: {gid: userGid},
    ...overrides
  })
  mockSubtasks(taskGid, [subtask])
  mockFindTaskById(subtaskGid, subtask)
  mockFindUserById(
    userGid,
    makeUser({gid: userGid, email: 'reviewer@example.com'})
  )
}

describe('review subtask creation with REVIEW_TASKS_AS_APPROVALS', () => {
  it('creates the subtask as a pending approval task', async () => {
    const taskGid = '8300'
    mockBaseTaskLookup(taskGid)
    mockSubtasks(taskGid, [])
    const addSubtaskScope = mockAddSubtask(
      taskGid,
      data => {
        expect(data.resource_subtype).toBe('approval')
        expect(data.approval_status).toBe('pending')
        expect(data.assignee).toBe('reviewer@example.com')
        expect(data.html_notes).toContain('approval status')
        return true
      },
      makeSubtask({gid: '8301', resource_subtype: 'approval'})
    )

    const {setFailed} = await runAction({
      eventName: 'pull_request',
      payload: REVIEW_REQUESTED_EVENT,
      inputs: APPROVALS_ON
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(addSubtaskScope.isDone()).toBe(true)
  })

  it('falls back to a plain subtask when Asana rejects the approval task', async () => {
    const taskGid = '8310'
    mockBaseTaskLookup(taskGid)
    mockSubtasks(taskGid, [])
    const failedScope = mockAddSubtaskFails(taskGid)
    const fallbackScope = mockAddSubtask(
      taskGid,
      data => {
        expect(data.resource_subtype).toBeUndefined()
        expect(data.approval_status).toBeUndefined()
        expect(data.assignee).toBe('reviewer@example.com')
        return true
      },
      makeSubtask({gid: '8311'})
    )

    const {setFailed} = await runAction({
      eventName: 'pull_request',
      payload: REVIEW_REQUESTED_EVENT,
      inputs: APPROVALS_ON
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(failedScope.isDone()).toBe(true)
    expect(fallbackScope.isDone()).toBe(true)
  })

  it('creates a plain subtask when the option is off', async () => {
    const taskGid = '8320'
    mockBaseTaskLookup(taskGid)
    mockSubtasks(taskGid, [])
    const addSubtaskScope = mockAddSubtask(
      taskGid,
      data => {
        expect(data.resource_subtype).toBeUndefined()
        expect(data.approval_status).toBeUndefined()
        expect(data.html_notes).toContain('automatically closed')
        return true
      },
      makeSubtask({gid: '8321'})
    )

    await runAction({
      eventName: 'pull_request',
      payload: REVIEW_REQUESTED_EVENT,
      inputs: {USER_MAP}
    })

    expect(addSubtaskScope.isDone()).toBe(true)
  })
})

describe('review verdicts on an approval subtask', () => {
  const verdictCases = [
    {
      description: 'an approval',
      payload: APPROVED_EVENT,
      approvalStatus: 'approved'
    },
    {
      description: 'a changes-requested review',
      payload: CHANGES_REQUESTED_EVENT,
      approvalStatus: 'changes_requested'
    }
  ]

  it.each(verdictCases)(
    'records $description as $approvalStatus',
    async ({payload, approvalStatus}) => {
      const taskGid = '8400'
      mockBaseTaskLookup(taskGid)
      mockExistingReviewSubtask(taskGid, '8401', '9700', {
        resource_subtype: 'approval',
        completed: false
      })
      const verdictScope = mockUpdateTask('8401', data => {
        expect(data.approval_status).toBe(approvalStatus)
        expect(data.completed).toBe(true)
        return true
      })

      const {setFailed} = await runAction({
        eventName: 'pull_request_review',
        payload,
        inputs: APPROVALS_ON
      })

      expect(setFailed).not.toHaveBeenCalled()
      expect(verdictScope.isDone()).toBe(true)
    }
  )

  const pendingCases = [
    {description: 'a commented review', payload: COMMENTED_EVENT},
    {description: 'a dismissed review', payload: DISMISSED_EVENT}
  ]

  it.each(pendingCases)(
    'puts the approval back to pending for $description',
    async ({payload}) => {
      const taskGid = '8410'
      mockBaseTaskLookup(taskGid)
      mockExistingReviewSubtask(taskGid, '8411', '9710', {
        resource_subtype: 'approval',
        completed: true
      })
      const pendingScope = mockUpdateTask('8411', data => {
        expect(data.approval_status).toBe('pending')
        expect(data.completed).toBe(false)
        return true
      })

      const {setFailed} = await runAction({
        eventName: 'pull_request_review',
        payload,
        inputs: APPROVALS_ON
      })

      expect(setFailed).not.toHaveBeenCalled()
      expect(pendingScope.isDone()).toBe(true)
    }
  )

  it('leaves an approval that is already pending alone', async () => {
    const taskGid = '8420'
    mockBaseTaskLookup(taskGid)
    mockExistingReviewSubtask(taskGid, '8421', '9720', {
      resource_subtype: 'approval',
      completed: false
    })
    // Registered so an unexpected call succeeds instead of tripping
    // disableNetConnect; the assertion is that it's never consumed.
    const updateScope = mockUpdateTask('8421', () => true)

    await runAction({
      eventName: 'pull_request_review',
      payload: COMMENTED_EVENT,
      inputs: APPROVALS_ON
    })

    expect(updateScope.isDone()).toBe(false)
  })
})

describe('review verdicts on a pre-existing plain subtask', () => {
  it('completes it without writing any approval fields', async () => {
    const taskGid = '8500'
    mockBaseTaskLookup(taskGid)
    mockExistingReviewSubtask(taskGid, '8501', '9800', {
      resource_subtype: 'default_task',
      completed: false
    })
    const completeScope = mockUpdateTask('8501', data => {
      expect(data.completed).toBe(true)
      expect(data.approval_status).toBeUndefined()
      expect(data.resource_subtype).toBeUndefined()
      return true
    })

    const {setFailed} = await runAction({
      eventName: 'pull_request_review',
      payload: APPROVED_EVENT,
      // On, to show the option governs creation only: an existing plain task
      // is never converted.
      inputs: APPROVALS_ON
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(completeScope.isDone()).toBe(true)
  })

  it('is not reopened by a commented review, as before', async () => {
    const taskGid = '8510'
    mockBaseTaskLookup(taskGid)
    mockExistingReviewSubtask(taskGid, '8511', '9810', {
      resource_subtype: 'default_task',
      completed: true
    })
    // Registered so an unexpected call succeeds instead of tripping
    // disableNetConnect; the assertion is that it's never consumed.
    const updateScope = mockUpdateTask('8511', () => true)

    await runAction({
      eventName: 'pull_request_review',
      payload: COMMENTED_EVENT,
      inputs: APPROVALS_ON
    })

    expect(updateScope.isDone()).toBe(false)
  })
})

describe('pull request closed', () => {
  it('approves outstanding approvals, completes plain tasks, keeps verdicts', async () => {
    const taskGid = '8600'
    mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
    mockSearchTasksInWorkspace(WORKSPACE_ID, [makeTask({gid: taskGid})])
    mockSubtasks(taskGid, [
      makeSubtask({
        gid: '8601',
        resource_subtype: 'approval',
        completed: false
      }),
      makeSubtask({gid: '8602', resource_subtype: 'approval', completed: true}),
      makeSubtask({gid: '8603', completed: false})
    ])
    const approvalScope = mockUpdateTask('8601', data => {
      expect(data.approval_status).toBe('approved')
      expect(data.completed).toBe(true)
      return true
    })
    // Registered so an unexpected call succeeds instead of tripping
    // disableNetConnect; the assertion is that it's never consumed.
    const decidedScope = mockUpdateTask('8602', () => true)
    const plainScope = mockUpdateTask('8603', data => {
      expect(data.completed).toBe(true)
      expect(data.approval_status).toBeUndefined()
      return true
    })
    mockFindTaskById(taskGid, makeTask({gid: taskGid, memberships: []}))
    const finalUpdate = mockUpdateTask(taskGid, data => {
      expect(data.completed).toBe(true)
      return true
    })

    // No REVIEW_TASKS_AS_APPROVALS: how a subtask is closed follows the
    // subtask's own type, not the option.
    const {setFailed} = await runAction({
      eventName: 'pull_request',
      payload: CLOSED_EVENT
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(approvalScope.isDone()).toBe(true)
    expect(plainScope.isDone()).toBe(true)
    expect(decidedScope.isDone()).toBe(false)
    expect(finalUpdate.isDone()).toBe(true)
  })
})
