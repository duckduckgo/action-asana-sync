import nock from 'nock'

import {makeSubtask, makeTask} from '../fixtures/asana/factories'
import {WORKSPACE_ID} from './harness'

// The `asana` client (npm package) talks plain REST+JSON to this base URL
// via `superagent`, which rides on Node's core http/https modules -- so
// nock can intercept it transparently. Endpoints below were confirmed by
// reading node_modules/asana/src/api/*.js.
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

/**
 * Mocks a single page of the (offset-paginated) custom fields listing.
 * Pass `nextOffset` to indicate more pages follow, and `offset` to match
 * the request that asks for this specific page.
 */
export function mockCustomFieldsPage(
  workspaceGid: string,
  fields: unknown[],
  {offset, nextOffset}: {offset?: string; nextOffset?: string} = {}
): nock.Scope {
  const query: Record<string, string> = {limit: '100'}
  if (offset) query.offset = offset
  return scope()
    .get(`${API}/workspaces/${workspaceGid}/custom_fields`)
    .query(query)
    .reply(200, {
      data: fields,
      next_page: nextOffset ? {offset: nextOffset} : null
    })
}

/**
 * Mocks the workspace custom-fields endpoint failing once with a 429 and
 * succeeding on the retry, to exercise the rate-limit backoff wrapper
 * end-to-end. `retryAfter`, if given, is sent back as the `Retry-After`
 * header (seconds); pass `'0'` to keep the test's actual wait time near-zero.
 */
export function mockCustomFieldsRateLimitedOnce(
  workspaceGid: string,
  fields: unknown[],
  {retryAfter}: {retryAfter?: string} = {}
): {failed: nock.Scope; succeeded: nock.Scope} {
  const urlPath = `${API}/workspaces/${workspaceGid}/custom_fields`
  const failed = scope()
    .get(urlPath)
    .query(true)
    .reply(
      429,
      {errors: [{message: 'Too Many Requests'}]},
      retryAfter ? {'Retry-After': retryAfter} : undefined
    )
  const succeeded = scope().get(urlPath).query(true).reply(200, {data: fields})
  return {failed, succeeded}
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

export function mockAddSubtaskFails(taskGid: string, status = 400): nock.Scope {
  return scope()
    .post(`${API}/tasks/${taskGid}/subtasks`)
    .reply(status, {errors: [{message: 'subtask creation failed'}]})
}

/**
 * Mocks the custom-field and search lookups every run makes to find the PR's own
 * Asana task, and returns the scope for the update it finishes with, so a caller
 * that cares can pass a matcher and assert on it.
 */
export function mockPRTaskLookup(
  taskGid: string,
  customFields: unknown[],
  updateMatcher: (data: JSONBody) => boolean = () => true
): nock.Scope {
  mockCustomFields(WORKSPACE_ID, customFields)
  mockSearchTasksInWorkspace(WORKSPACE_ID, [makeTask({gid: taskGid})])
  return mockUpdateTask(taskGid, updateMatcher)
}

/**
 * Mocks an existing review subtask assigned to a reviewer, wiring up the
 * subtask-listing lookup the action matches a subtask to that reviewer
 * against (assignee gid/email come back with the listing itself, via
 * opt_fields, rather than a separate per-subtask lookup).
 */
export function mockExistingReviewSubtask(
  taskGid: string,
  {
    subtaskGid,
    userGid,
    email = 'reviewer@example.com',
    ...overrides
  }: {
    subtaskGid: string
    userGid: string
    email?: string
    [field: string]: unknown
  }
): void {
  const subtask = makeSubtask({
    gid: subtaskGid,
    assignee: {gid: userGid, email},
    ...overrides
  })
  mockSubtasks(taskGid, [subtask])
}

/**
 * Registers an update that must never be called: nock's disableNetConnect turns
 * an unmocked request into a failure rather than the assertion we want, so the
 * caller asserts `scope.isDone() === false` against this instead.
 */
export function mockUpdateTaskNeverCalled(taskGid: string): nock.Scope {
  return mockUpdateTask(taskGid, () => true)
}
