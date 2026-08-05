import nock from 'nock'

// The `asana` client (github:Asana/node-asana) talks plain REST+JSON to
// this base URL via the (deprecated) `request` package, which rides on
// Node's core http/https modules -- so nock can intercept it transparently.
// Endpoints below were confirmed by reading node_modules/asana/lib/resources.
const BASE_URL = 'https://app.asana.com'
const API = '/api/1.0'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JSONBody = Record<string, any>

function scope(): nock.Scope {
  return nock(BASE_URL)
}

/** Matches the `{data: <data>}` envelope every POST/PUT body is wrapped in. */
function dataBody(matcher: (data: JSONBody) => boolean) {
  return (body: JSONBody) => matcher(body.data)
}

/** A GET that returns a `{data: <data>}` collection or single resource. */
function mockGet(urlPath: string, data: unknown): nock.Scope {
  return scope().get(urlPath).query(true).reply(200, {data})
}

export function mockCustomFields(
  workspaceGid: string,
  fields: unknown[]
): nock.Scope {
  return mockGet(`${API}/workspaces/${workspaceGid}/custom_fields`, fields)
}

export function mockSearchTasksInWorkspace(
  workspaceGid: string,
  tasks: unknown[]
): nock.Scope {
  return mockGet(`${API}/workspaces/${workspaceGid}/tasks/search`, tasks)
}

export function mockProjectTasks(
  projectGid: string,
  tasks: unknown[]
): nock.Scope {
  return mockGet(`${API}/projects/${projectGid}/tasks`, tasks)
}

export function mockCreateTask(
  matcher: (data: JSONBody) => boolean,
  responseTask: unknown
): nock.Scope {
  return scope()
    .post(`${API}/tasks`, dataBody(matcher))
    .reply(201, {data: responseTask})
}

export function mockFindTaskById(taskGid: string, task: unknown): nock.Scope {
  return mockGet(`${API}/tasks/${taskGid}`, task)
}

export function mockFindTaskByIdFails(
  taskGid: string,
  status = 404
): nock.Scope {
  return scope()
    .get(`${API}/tasks/${taskGid}`)
    .query(true)
    .reply(status, {errors: [{message: 'not found'}]})
}

export function mockUpdateTask(
  taskGid: string,
  matcher: (data: JSONBody) => boolean,
  responseTask: unknown = {}
): nock.Scope {
  return scope()
    .put(`${API}/tasks/${taskGid}`, dataBody(matcher))
    .reply(200, {data: responseTask})
}

export function mockUpdateTaskFails(taskGid: string, status = 500): nock.Scope {
  return scope()
    .put(`${API}/tasks/${taskGid}`)
    .reply(status, {errors: [{message: 'update failed'}]})
}

export function mockSubtasks(taskGid: string, subtasks: unknown[]): nock.Scope {
  return mockGet(`${API}/tasks/${taskGid}/subtasks`, subtasks)
}

export function mockAddSubtask(
  taskGid: string,
  matcher: (data: JSONBody) => boolean,
  responseSubtask: unknown
): nock.Scope {
  return scope()
    .post(`${API}/tasks/${taskGid}/subtasks`, dataBody(matcher))
    .reply(201, {data: responseSubtask})
}

export function mockFindUserById(userGid: string, user: unknown): nock.Scope {
  return mockGet(`${API}/users/${userGid}`, user)
}
