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
    mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
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
    mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
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

  it('creates a new task if no matching task is found after exhausting retries', async () => {
    // Pin Math.random so the retry loop's jittered maxRetries (3-7) and
    // per-attempt delay (20-30s) are deterministic, and short-circuit the
    // real setTimeout so the 3 waits don't actually take a minute.
    jest.spyOn(global.Math, 'random').mockReturnValue(0)
    jest
      .spyOn(global, 'setTimeout')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((fn: any) => {
        fn()
        return 0 as unknown as NodeJS.Timeout
      })

    mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
    for (let i = 0; i < 3; i++) {
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
})
