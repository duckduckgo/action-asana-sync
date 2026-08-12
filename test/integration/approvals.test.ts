import {runAction, loadFixture} from './helpers/harness'
import {
  mockSubtasks,
  mockAddSubtask,
  mockAddSubtaskFails,
  mockExistingReviewSubtask,
  mockFindTaskById,
  mockPRTaskLookup,
  mockUpdateTask,
  mockUpdateTaskNeverCalled
} from './helpers/mock-asana'
import {makeSubtask, makeTask} from './fixtures/asana/factories'
import './setup'

const CUSTOM_FIELDS = loadFixture('fixtures/asana/custom-fields.json')
const REVIEW_REQUESTED_EVENT = loadFixture(
  'fixtures/events/pull_request.review_requested.json'
)
const APPROVED_EVENT = loadFixture(
  'fixtures/events/pull_request_review.submitted.approved.json'
)
const CLOSED_EVENT = loadFixture(
  'fixtures/events/pull_request.closed.merged.json'
)

/** The approved-review fixture with a different action/verdict on it. */
function reviewEvent(action: string, state: string): unknown {
  return {
    ...APPROVED_EVENT,
    action,
    review: {...APPROVED_EVENT.review, state}
  }
}

const CHANGES_REQUESTED_EVENT = reviewEvent('submitted', 'changes_requested')
const COMMENTED_EVENT = reviewEvent('submitted', 'commented')
const DISMISSED_EVENT = reviewEvent('dismissed', 'dismissed')

const USER_MAP = JSON.stringify({'reviewer-bot': 'reviewer@example.com'})
const APPROVALS_ON = {REVIEW_TASKS_AS_APPROVALS: 'true', USER_MAP}

describe('review subtask creation with REVIEW_TASKS_AS_APPROVALS', () => {
  it('creates the subtask as a pending approval task', async () => {
    const taskGid = '8300'
    mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
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

  it('falls back to a plain subtask, with plain notes, when Asana rejects the approval', async () => {
    const taskGid = '8310'
    mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
    mockSubtasks(taskGid, [])
    const failedScope = mockAddSubtaskFails(taskGid)
    const fallbackScope = mockAddSubtask(
      taskGid,
      data => {
        expect(data.resource_subtype).toBeUndefined()
        expect(data.approval_status).toBeUndefined()
        expect(data.assignee).toBe('reviewer@example.com')
        // The approval wording must not survive onto a plain task.
        expect(data.html_notes).toContain('automatically closed')
        expect(data.html_notes).not.toContain('approval status')
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

  const twoReviewerCases = [
    {
      description: 'keeps trying for later reviewers after a transient failure',
      status: 429,
      secondReviewerGetsApproval: true
    },
    {
      description: 'stops trying once a create is refused outright',
      status: 400,
      secondReviewerGetsApproval: false
    }
  ]

  it.each(twoReviewerCases)(
    '$description',
    async ({status, secondReviewerGetsApproval}) => {
      const taskGid = '8330'
      mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
      mockSubtasks(taskGid, [])
      // getReviewerLogins() reads the PR's current state, so both users get a
      // subtask from this one event.
      const payload = {
        ...REVIEW_REQUESTED_EVENT,
        pull_request: {
          ...REVIEW_REQUESTED_EVENT.pull_request,
          assignees: [{login: 'alice'}],
          requested_reviewers: [{login: 'reviewer-bot'}]
        }
      }
      const failedScope = mockAddSubtaskFails(taskGid, status)
      // alice's fallback.
      mockAddSubtask(
        taskGid,
        data => data.assignee === 'alice@example.com',
        makeSubtask({gid: '8331'})
      )
      const secondReviewerScope = mockAddSubtask(
        taskGid,
        data => {
          expect(data.assignee).toBe('reviewer@example.com')
          expect(data.resource_subtype).toBe(
            secondReviewerGetsApproval ? 'approval' : undefined
          )
          return true
        },
        makeSubtask({gid: '8332'})
      )

      const {setFailed} = await runAction({
        eventName: 'pull_request',
        payload,
        inputs: {
          ...APPROVALS_ON,
          INCLUDE_ASSIGNEES: 'true',
          USER_MAP: JSON.stringify({
            alice: 'alice@example.com',
            'reviewer-bot': 'reviewer@example.com'
          })
        }
      })

      expect(setFailed).not.toHaveBeenCalled()
      expect(failedScope.isDone()).toBe(true)
      expect(secondReviewerScope.isDone()).toBe(true)
    }
  )

  it('creates a plain subtask when the option is off', async () => {
    const taskGid = '8320'
    mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
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
    'records $description as $approvalStatus in a single write',
    async ({payload, approvalStatus}) => {
      const taskGid = '8400'
      mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
      mockExistingReviewSubtask(taskGid, {
        subtaskGid: '8401',
        userGid: '9700',
        resource_subtype: 'approval',
        // Already decided: the verdict must not flap through pending first.
        completed: true
      })
      const verdictScope = mockUpdateTask('8401', data => {
        expect(data.approval_status).toBe(approvalStatus)
        expect(data.completed).toBe(true)
        return true
      })
      // Consumed only by a second write, which there should not be.
      const extraWriteScope = mockUpdateTaskNeverCalled('8401')

      const {setFailed} = await runAction({
        eventName: 'pull_request_review',
        payload,
        inputs: APPROVALS_ON
      })

      expect(setFailed).not.toHaveBeenCalled()
      expect(verdictScope.isDone()).toBe(true)
      expect(extraWriteScope.isDone()).toBe(false)
    }
  )

  const pendingCases = [
    {description: 'a commented review', payload: COMMENTED_EVENT},
    {description: 'a dismissed review', payload: DISMISSED_EVENT}
  ]

  it.each(pendingCases)(
    'puts a decided approval back to pending for $description',
    async ({payload}) => {
      const taskGid = '8410'
      mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
      mockExistingReviewSubtask(taskGid, {
        subtaskGid: '8411',
        userGid: '9710',
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
    mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
    mockExistingReviewSubtask(taskGid, {
      subtaskGid: '8421',
      userGid: '9720',
      resource_subtype: 'approval',
      completed: false
    })
    const updateScope = mockUpdateTaskNeverCalled('8421')

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
    mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
    mockExistingReviewSubtask(taskGid, {
      subtaskGid: '8501',
      userGid: '9800',
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
      // On, to show the option governs creation only: an existing plain task is
      // never converted.
      inputs: APPROVALS_ON
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(completeScope.isDone()).toBe(true)
  })

  it('is not reopened by a commented review, as before', async () => {
    const taskGid = '8510'
    mockPRTaskLookup(taskGid, CUSTOM_FIELDS)
    mockExistingReviewSubtask(taskGid, {
      subtaskGid: '8511',
      userGid: '9810',
      completed: true
    })
    const updateScope = mockUpdateTaskNeverCalled('8511')

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
    // No REVIEW_TASKS_AS_APPROVALS below: how a subtask is closed follows the
    // subtask's own type, not the option.
    const finalUpdate = mockPRTaskLookup(taskGid, CUSTOM_FIELDS, data => {
      expect(data.completed).toBe(true)
      return true
    })
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
    const decidedScope = mockUpdateTaskNeverCalled('8602')
    const plainScope = mockUpdateTask('8603', data => {
      expect(data.completed).toBe(true)
      expect(data.approval_status).toBeUndefined()
      return true
    })
    mockFindTaskById(taskGid, makeTask({gid: taskGid, memberships: []}))

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
