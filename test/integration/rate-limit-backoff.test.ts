import nock from 'nock'

import {runAction, loadFixture} from './helpers/harness'
import {
  mockCustomFieldsRateLimitedOnce,
  mockCreateTask,
  mockFindTaskById,
  mockSubtasks,
  mockUpdateTask
} from './helpers/mock-asana'
import {makeTask} from './fixtures/asana/factories'
import './setup'

const CUSTOM_FIELDS = loadFixture('fixtures/asana/custom-fields.json')
const OPENED_EVENT = loadFixture('fixtures/events/pull_request.opened.json')

const PROJECT_ID = '2000'

describe('Asana rate limiting (429)', () => {
  it('retries a rate-limited request and completes the run', async () => {
    // retryAfter: '0' keeps the test's real wait time near-zero while still
    // exercising the header-driven delay path.
    const {failed, succeeded} = mockCustomFieldsRateLimitedOnce(
      PROJECT_ID,
      CUSTOM_FIELDS,
      {retryAfter: '0'}
    )
    mockFindTaskById('9876543210', makeTask({gid: '9876543210'}))
    const createdTask = makeTask({gid: '5100'})
    const createScope = mockCreateTask(() => true, createdTask)
    mockSubtasks('5100', [])
    mockUpdateTask('5100', () => true)

    const {setFailed, setOutput} = await runAction({
      eventName: 'pull_request',
      payload: OPENED_EVENT
    })

    expect(setFailed).not.toHaveBeenCalled()
    expect(setOutput).toHaveBeenCalledWith('result', 'created')
    expect(failed.isDone()).toBe(true)
    expect(succeeded.isDone()).toBe(true)
    expect(createScope.isDone()).toBe(true)
  })

  it('fails the run when every retry is also rate-limited', async () => {
    const urlPath = `/api/1.0/projects/${PROJECT_ID}/custom_field_settings`
    const alwaysLimited = nock('https://app.asana.com')
      .get(urlPath)
      .query(true)
      .times(6) // 1 initial attempt + 5 retries
      .reply(
        429,
        {errors: [{message: 'Too Many Requests'}]},
        {
          'Retry-After': '0'
        }
      )

    const {setFailed} = await runAction({
      eventName: 'pull_request',
      payload: OPENED_EVENT
    })

    expect(setFailed).toHaveBeenCalledTimes(1)
    expect(setFailed.mock.calls[0][0]).toContain('Too Many Requests')
    expect(alwaysLimited.isDone()).toBe(true)
  })
})
