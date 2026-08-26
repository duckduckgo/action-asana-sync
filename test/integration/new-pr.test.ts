import {runAction, loadFixture} from './helpers/harness'
import {
  mockCustomFields,
  mockCustomFieldsPage,
  mockWorkspaceCustomFields,
  mockCreateTask,
  mockFindTaskById,
  mockFindTaskByIdFails,
  mockPRTaskNotFound,
  mockSearchTasksInWorkspace,
  mockSubtasks,
  mockUpdateTask,
  mockUpdateTaskFails
} from './helpers/mock-asana'
import {makeTask} from './fixtures/asana/factories'
import './setup'

const CUSTOM_FIELDS = loadFixture('fixtures/asana/custom-fields.json')
const OPENED_EVENT = loadFixture('fixtures/events/pull_request.opened.json')

const WORKSPACE_ID = '1000'
const PROJECT_ID = '2000'

describe('new pull request (opened)', () => {
  it('creates a task, links the Asana task mentioned in the body as parent, and reports created', async () => {
    mockCustomFields(PROJECT_ID, CUSTOM_FIELDS)
    mockPRTaskNotFound()
    mockFindTaskById('9876543210', makeTask({gid: '9876543210'}))
    const createdTask = makeTask({
      gid: '5000',
      permalink_url: 'https://app.asana.com/0/2000/5000'
    })
    const createScope = mockCreateTask(data => {
      expect(data.name).toBe(
        'PR action-asana-sync #42: Add sprinkles to the frontend'
      )
      expect(data.projects).toEqual([PROJECT_ID])
      expect(data.parent).toBe('9876543210')
      expect(data.assignee).toBeUndefined()
      expect(data.custom_fields['111']).toBe(
        'https://github.com/duckduckgo/action-asana-sync/pull/42'
      )
      expect(data.custom_fields['222']).toBe('222-1') // Open
      return true
    }, createdTask)
    mockSubtasks('5000', [])
    const updateScope = mockUpdateTask('5000', () => true)

    const {setOutput, setFailed} = await runAction({
      eventName: 'pull_request',
      payload: OPENED_EVENT
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(setOutput).toHaveBeenCalledWith('result', 'created')
    expect(setOutput).toHaveBeenCalledWith(
      'task_url',
      'https://app.asana.com/0/2000/5000'
    )
    expect(createScope.isDone()).toBe(true)
    expect(updateScope.isDone()).toBe(true)
  })

  it('omits the parent link when the referenced Asana task cannot be accessed', async () => {
    mockCustomFields(PROJECT_ID, CUSTOM_FIELDS)
    mockPRTaskNotFound()
    mockFindTaskByIdFails('9876543210', 404)
    const createdTask = makeTask({gid: '5001'})
    const createScope = mockCreateTask(data => {
      expect(data.parent).toBeUndefined()
      return true
    }, createdTask)
    mockSubtasks('5001', [])
    mockUpdateTask('5001', () => true)

    const {setFailed} = await runAction({
      eventName: 'pull_request',
      payload: OPENED_EVENT
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(createScope.isDone()).toBe(true)
  })

  it('does not assign the task when ASSIGN_PR_AUTHOR is false', async () => {
    mockCustomFields(PROJECT_ID, CUSTOM_FIELDS)
    mockPRTaskNotFound()
    mockFindTaskById('9876543210', makeTask({gid: '9876543210'}))
    const createScope = mockCreateTask(
      data => {
        expect(data.assignee).toBeUndefined()
        return true
      },
      makeTask({gid: '5002'})
    )
    mockSubtasks('5002', [])
    mockUpdateTask('5002', () => true)

    await runAction({
      eventName: 'pull_request',
      payload: OPENED_EVENT,
      inputs: {ASSIGN_PR_AUTHOR: 'false'}
    })

    expect(createScope.isDone()).toBe(true)
  })

  it('assigns the task to the mapped Asana user when ASSIGN_PR_AUTHOR is true', async () => {
    mockCustomFields(PROJECT_ID, CUSTOM_FIELDS)
    mockPRTaskNotFound()
    mockFindTaskById('9876543210', makeTask({gid: '9876543210'}))
    const createScope = mockCreateTask(
      data => {
        expect(data.assignee).toBe('author@example.com')
        return true
      },
      makeTask({gid: '5003'})
    )
    mockSubtasks('5003', [])
    mockUpdateTask('5003', () => true)

    await runAction({
      eventName: 'pull_request',
      payload: OPENED_EVENT,
      inputs: {
        ASSIGN_PR_AUTHOR: 'true',
        USER_MAP: JSON.stringify({octocat: 'author@example.com'})
      }
    })

    expect(createScope.isDone()).toBe(true)
  })

  it('falls back to plaintext notes when updating with html_notes fails', async () => {
    mockCustomFields(PROJECT_ID, CUSTOM_FIELDS)
    mockPRTaskNotFound()
    mockFindTaskById('9876543210', makeTask({gid: '9876543210'}))
    mockCreateTask(() => true, makeTask({gid: '5004'}))
    mockSubtasks('5004', [])

    mockUpdateTaskFails('5004', 500)
    const plaintextUpdate = mockUpdateTask('5004', data => {
      expect(data.notes).toBeDefined()
      expect(data.html_notes).toBeUndefined()
      return true
    })

    const {setFailed} = await runAction({
      eventName: 'pull_request',
      payload: OPENED_EVENT
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(plaintextUpdate.isDone()).toBe(true)
  })

  it('paginates through all custom fields when the project has more than one page', async () => {
    // The project has >100 custom fields attached, so the ones we need
    // ("Github URL" and "Github Status") only show up on the second page.
    const firstPageFields = Array.from({length: 100}, (_, i) => ({
      gid: `unrelated-${i}`,
      name: `Unrelated field ${i}`
    }))
    mockCustomFieldsPage(PROJECT_ID, firstPageFields, {
      nextOffset: 'page-2-token'
    })
    mockCustomFieldsPage(PROJECT_ID, CUSTOM_FIELDS, {
      offset: 'page-2-token'
    })
    mockPRTaskNotFound()
    mockFindTaskById('9876543210', makeTask({gid: '9876543210'}))
    const createdTask = makeTask({gid: '5005'})
    const createScope = mockCreateTask(() => true, createdTask)
    mockSubtasks('5005', [])
    mockUpdateTask('5005', () => true)

    const {setFailed, setOutput} = await runAction({
      eventName: 'pull_request',
      payload: OPENED_EVENT
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(setOutput).toHaveBeenCalledWith('result', 'created')
    expect(createScope.isDone()).toBe(true)
  })

  it('stops paginating once both required fields are found, without fetching later pages', async () => {
    // Both target fields are already on page 1 (mixed in with unrelated
    // fields), which also indicates a page 2 exists. A lazy scan has no
    // reason to ever ask for it.
    mockCustomFieldsPage(
      PROJECT_ID,
      [...CUSTOM_FIELDS, {gid: '999', name: 'Unrelated'}],
      {
        nextOffset: 'page-2-token'
      }
    )
    const page2Scope = mockCustomFieldsPage(PROJECT_ID, [], {
      offset: 'page-2-token'
    })
    mockPRTaskNotFound()
    mockFindTaskById('9876543210', makeTask({gid: '9876543210'}))
    const createdTask = makeTask({gid: '5010'})
    const createScope = mockCreateTask(() => true, createdTask)
    mockSubtasks('5010', [])
    mockUpdateTask('5010', () => true)

    const {setFailed, setOutput} = await runAction({
      eventName: 'pull_request',
      payload: OPENED_EVENT
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(setOutput).toHaveBeenCalledWith('result', 'created')
    expect(createScope.isDone()).toBe(true)
    expect(page2Scope.isDone()).toBe(false)
  })

  it('falls back to a workspace-wide scan when a required field is missing from the project', async () => {
    // The project's own custom field settings are missing "Github Status"
    // (e.g. it was never attached there), but it still exists somewhere in
    // the workspace.
    mockCustomFields(PROJECT_ID, [{gid: '111', name: 'Github URL'}])
    mockWorkspaceCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
    mockPRTaskNotFound()
    mockFindTaskById('9876543210', makeTask({gid: '9876543210'}))
    const createdTask = makeTask({gid: '5006'})
    const createScope = mockCreateTask(() => true, createdTask)
    mockSubtasks('5006', [])
    mockUpdateTask('5006', () => true)

    const {setFailed, setOutput} = await runAction({
      eventName: 'pull_request',
      payload: OPENED_EVENT
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(setOutput).toHaveBeenCalledWith('result', 'created')
    expect(createScope.isDone()).toBe(true)
  })

  it('fails gracefully when the required custom fields are missing from both the project and the workspace', async () => {
    mockCustomFields(PROJECT_ID, [
      {gid: '111', name: 'Github URL'}
      // "Github Status" missing
    ])
    mockWorkspaceCustomFields(WORKSPACE_ID, [
      {gid: '111', name: 'Github URL'}
      // "Github Status" missing here too, so the fallback also comes up short.
    ])

    const {setFailed, setOutput} = await runAction({
      eventName: 'pull_request',
      payload: OPENED_EVENT
    })

    expect(setFailed).toHaveBeenCalledTimes(1)
    expect(setFailed.mock.calls[0][0]).toContain('Custom fields are missing')
    expect(setOutput).not.toHaveBeenCalled()
  })

  it('updates the existing task instead of creating one when another run got there first', async () => {
    // GitHub delivers a new PR's events (`opened`, `review_requested`, bot
    // `edited`s) in no guaranteed order, so by the time the `opened` run
    // executes - e.g. queued behind another run by a concurrency group -
    // that other run may already have created the task. `opened` must then
    // update it, not create a duplicate. An unexpected create would hit
    // nock's disabled network and fail the run, so setFailed doubles as the
    // no-create assertion.
    mockCustomFields(PROJECT_ID, CUSTOM_FIELDS)
    const existingTask = makeTask({
      gid: '6100',
      permalink_url: 'https://app.asana.com/0/2000/6100'
    })
    mockSearchTasksInWorkspace(WORKSPACE_ID, [existingTask])
    mockSubtasks('6100', [])
    const updateScope = mockUpdateTask('6100', () => true)

    const {setOutput, setFailed} = await runAction({
      eventName: 'pull_request',
      payload: OPENED_EVENT
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(setOutput).toHaveBeenCalledWith('result', 'updated')
    expect(setOutput).toHaveBeenCalledWith(
      'task_url',
      'https://app.asana.com/0/2000/6100'
    )
    expect(updateScope.isDone()).toBe(true)
  })
})
