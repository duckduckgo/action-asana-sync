import {runAction, loadFixture} from './helpers/harness'
import {
  mockCustomFields,
  mockSearchTasksInWorkspace,
  mockProjectTasks,
  mockCreateTask,
  mockSubtasks,
  mockUpdateTask
} from './helpers/mock-asana'
import {makeTask} from './fixtures/asana/factories'
import './setup'

const CUSTOM_FIELDS = loadFixture('fixtures/asana/custom-fields.json')
const SYNCHRONIZE_EVENT = loadFixture(
  'fixtures/events/pull_request.synchronize.json'
)

const WORKSPACE_ID = '1000'
const PROJECT_ID = '2000'
const PR_URL = 'https://github.com/duckduckgo/action-asana-sync/pull/42'

describe('existing pull request updates', () => {
  it('finds the task via workspace search and updates it', async () => {
    mockCustomFields(PROJECT_ID, CUSTOM_FIELDS)
    const existingTask = makeTask({gid: '6000'})
    mockSearchTasksInWorkspace(WORKSPACE_ID, [existingTask])
    mockSubtasks('6000', [])
    const updateScope = mockUpdateTask('6000', data => {
      expect(data.name).toBe(
        'PR action-asana-sync #42: Add sprinkles to the frontend'
      )
      return true
    })

    const {setOutput, setFailed} = await runAction({
      eventName: 'pull_request',
      payload: SYNCHRONIZE_EVENT
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(setOutput).toHaveBeenCalledWith('result', 'updated')
    expect(updateScope.isDone()).toBe(true)
  })

  it('falls back to the project task list when search has not caught up yet', async () => {
    mockCustomFields(PROJECT_ID, CUSTOM_FIELDS)
    mockSearchTasksInWorkspace(WORKSPACE_ID, [])
    const existingTask = makeTask({
      gid: '6001',
      custom_fields: [{gid: '111', display_value: PR_URL}]
    })
    mockProjectTasks(PROJECT_ID, [existingTask])
    mockSubtasks('6001', [])
    const updateScope = mockUpdateTask('6001', () => true)

    const {setOutput} = await runAction({
      eventName: 'pull_request',
      payload: SYNCHRONIZE_EVENT
    })

    expect(setOutput).toHaveBeenCalledWith('result', 'updated')
    expect(updateScope.isDone()).toBe(true)
  })

  /**
   * Makes the wait-for-task loop deterministic and instant. Math.random is
   * pinned to 0 so the jittered give-up deadline (60-240s out) and the delay
   * between looks (20-30s) take their minimums, and the between-look sleeps
   * are short-circuited so the waits don't actually take a minute. Only those
   * delays (20-30s) are short-circuited: the asana client also schedules its
   * own request-timeout timer via setTimeout, which must run for real so it
   * can be cleared once nock resolves the (instant) request. Date.now serves
   * a fake clock that each short-circuited sleep advances by the slept delay,
   * so the loop's own sleeping is the only thing that moves time: the
   * deadline lands 60s out and each sleep covers 20s, giving the loop its
   * initial look plus exactly three more before it crosses the deadline.
   */
  function pinWaitLoopTimers(): void {
    jest.spyOn(global.Math, 'random').mockReturnValue(0)
    let fakeNow = 0
    jest.spyOn(Date, 'now').mockImplementation(() => fakeNow)
    const realSetTimeout = global.setTimeout
    jest
      .spyOn(global, 'setTimeout')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((fn: any, delay?: number) => {
        if (typeof delay === 'number' && delay >= 20000 && delay <= 30000) {
          fakeNow += delay
          fn()
          return 0 as unknown as NodeJS.Timeout
        }
        return realSetTimeout(fn, delay)
      })
  }

  it('creates a new task if no matching task appears by the give-up deadline', async () => {
    pinWaitLoopTimers()

    mockCustomFields(PROJECT_ID, CUSTOM_FIELDS)
    for (let i = 0; i < 4; i++) {
      mockSearchTasksInWorkspace(WORKSPACE_ID, [])
      mockProjectTasks(PROJECT_ID, [])
    }
    const createdTask = makeTask({gid: '6002'})
    const createScope = mockCreateTask(() => true, createdTask)
    mockSubtasks('6002', [])
    mockUpdateTask('6002', () => true)

    const {setOutput, setFailed} = await runAction({
      eventName: 'pull_request',
      payload: SYNCHRONIZE_EVENT
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(createScope.isDone()).toBe(true)
    expect(setOutput).toHaveBeenCalledWith('result', 'created')
  })

  it('picks up a task another run created while waiting, instead of creating a second one', async () => {
    pinWaitLoopTimers()

    // The first three looks find nothing; the task shows up on the loop's
    // last look before the give-up deadline - the parallel-runs race this
    // ordering simulates is exactly how two tasks get created. An unexpected
    // create would hit nock's disabled network and fail the run, so setFailed
    // doubles as the no-create assertion.
    mockCustomFields(PROJECT_ID, CUSTOM_FIELDS)
    for (let i = 0; i < 3; i++) {
      mockSearchTasksInWorkspace(WORKSPACE_ID, [])
      mockProjectTasks(PROJECT_ID, [])
    }
    const lateTask = makeTask({gid: '6003'})
    mockSearchTasksInWorkspace(WORKSPACE_ID, [lateTask])
    mockSubtasks('6003', [])
    const updateScope = mockUpdateTask('6003', () => true)

    const {setOutput, setFailed} = await runAction({
      eventName: 'pull_request',
      payload: SYNCHRONIZE_EVENT
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(setOutput).toHaveBeenCalledWith('result', 'updated')
    expect(updateScope.isDone()).toBe(true)
  })
})
