import fs from 'fs'
import path from 'path'
import {runAction} from './helpers/harness'
import {
  mockCustomFields,
  mockSearchTasksInWorkspace,
  mockSubtasks,
  mockFindTaskById,
  mockUpdateTask
} from './helpers/mock-asana'
import {makeTask, makeSubtask} from './fixtures/asana/factories'
import './setup'

const CUSTOM_FIELDS = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures/asana/custom-fields.json'),
    'utf8'
  )
)
const CLOSED_EVENT = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures/events/pull_request.closed.merged.json'),
    'utf8'
  )
)

const WORKSPACE_ID = '1000'

describe('pull request closed/merged', () => {
  it('marks the PR task completed when it is not in a NO_AUTOCLOSE project', async () => {
    const taskGid = '7000'
    mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
    mockSearchTasksInWorkspace(WORKSPACE_ID, [makeTask({gid: taskGid})])
    // closeSubtasks() runs un-awaited in main.ts; mock permissively so it
    // doesn't trip disableNetConnect if it fires before the test ends.
    mockSubtasks(taskGid, [makeSubtask({gid: '7001'})]).persist()
    mockUpdateTask('7001', () => true).persist()
    mockFindTaskById(taskGid, makeTask({gid: taskGid, memberships: []}))
    const finalUpdate = mockUpdateTask(taskGid, data => {
      expect(data.completed).toBe(true)
      return true
    })

    const {setFailed} = await runAction({
      eventName: 'pull_request',
      payload: CLOSED_EVENT
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(finalUpdate.isDone()).toBe(true)
  })

  it('leaves the PR task open when it belongs to a NO_AUTOCLOSE project', async () => {
    const taskGid = '7002'
    mockCustomFields(WORKSPACE_ID, CUSTOM_FIELDS)
    mockSearchTasksInWorkspace(WORKSPACE_ID, [makeTask({gid: taskGid})])
    mockSubtasks(taskGid, []).persist()
    mockFindTaskById(
      taskGid,
      makeTask({
        gid: taskGid,
        memberships: [{project: {gid: '9999', name: 'Release'}}]
      })
    )
    const finalUpdate = mockUpdateTask(taskGid, data => {
      expect(data.completed).toBe(false)
      return true
    })

    await runAction({
      eventName: 'pull_request',
      payload: CLOSED_EVENT,
      inputs: {NO_AUTOCLOSE_PROJECTS: '9999'}
    })

    expect(finalUpdate.isDone()).toBe(true)
  })
})
