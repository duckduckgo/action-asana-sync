import fs from 'fs'
import path from 'path'
import {runAction} from './helpers/harness'
import {
  mockCustomFields,
  mockCreateTask,
  mockFindTaskById,
  mockFindTaskByIdFails,
  mockSubtasks,
  mockUpdateTask,
  mockUpdateTaskFails
} from './helpers/mock-asana'
import {makeTask} from './fixtures/asana/factories'
import './setup'

const CUSTOM_FIELDS = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures/asana/custom-fields.json'),
    'utf8'
  )
)
const OPENED_EVENT = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures/events/pull_request.opened.json'),
    'utf8'
  )
)

const WORKSPACE_ID = '1000'
const PROJECT_ID = '2000'

describe('new pull request (opened)', () => {
  it('creates a task, links the Asana task mentioned in the body as parent, and reports created', async () => {
    mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
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
    mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
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
    mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
    mockFindTaskById('9876543210', makeTask({gid: '9876543210'}))
    const createScope = mockCreateTask(data => {
      expect(data.assignee).toBeUndefined()
      return true
    }, makeTask({gid: '5002'}))
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
    mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
    mockFindTaskById('9876543210', makeTask({gid: '9876543210'}))
    const createScope = mockCreateTask(data => {
      expect(data.assignee).toBe('author@example.com')
      return true
    }, makeTask({gid: '5003'}))
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
    mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
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

  it('fails gracefully when the required custom fields are missing in the workspace', async () => {
    mockCustomFields(WORKSPACE_ID, [
      {gid: '111', name: 'Github URL'}
      // "Github Status" missing
    ])

    const {setFailed, setOutput} = await runAction({
      eventName: 'pull_request',
      payload: OPENED_EVENT
    })

    expect(setFailed).toHaveBeenCalledTimes(1)
    expect(setFailed.mock.calls[0][0]).toContain('Custom fields are missing')
    expect(setOutput).not.toHaveBeenCalled()
  })
})
