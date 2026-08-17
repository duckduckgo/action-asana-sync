import type {ApiClient} from 'asana'

import {installAsanaRateLimitBackoff} from '../src/asana-retry'

type FakeCallApi = jest.Mock<
  Promise<{data: unknown; response: unknown}>,
  unknown[]
>

function fakeClient(): {callApi: FakeCallApi} {
  return {callApi: jest.fn()}
}

function rateLimitError(retryAfterSeconds?: number): unknown {
  return {
    status: 429,
    response: {
      headers:
        retryAfterSeconds !== undefined
          ? {'retry-after': String(retryAfterSeconds)}
          : {}
    }
  }
}

const CALL_ARGS = [
  '/workspaces/1/custom_fields',
  'GET',
  {},
  {},
  {},
  {},
  null,
  [],
  [],
  [],
  null
]

describe('installAsanaRateLimitBackoff', () => {
  it('retries a 429 with backoff and returns the eventual success', async () => {
    const client = fakeClient()
    const originalCallApi = client.callApi
    originalCallApi
      .mockRejectedValueOnce(rateLimitError())
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValueOnce({data: 'ok', response: {}})
    const wait = jest.fn().mockResolvedValue(undefined)

    installAsanaRateLimitBackoff(client as unknown as ApiClient, wait)
    const result = await (
      client.callApi as unknown as (...a: unknown[]) => Promise<unknown>
    )(...CALL_ARGS)

    expect(result).toEqual({data: 'ok', response: {}})
    expect(originalCallApi).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it("honors the response's Retry-After header, in milliseconds", async () => {
    const client = fakeClient()
    const originalCallApi = client.callApi
    originalCallApi
      .mockRejectedValueOnce(rateLimitError(2))
      .mockResolvedValueOnce({data: 'ok', response: {}})
    const wait = jest.fn().mockResolvedValue(undefined)

    installAsanaRateLimitBackoff(client as unknown as ApiClient, wait)
    await (client.callApi as unknown as (...a: unknown[]) => Promise<unknown>)(
      ...CALL_ARGS
    )

    expect(wait).toHaveBeenCalledWith(2000)
  })

  it('gives up after the max retries and rethrows the last error', async () => {
    const client = fakeClient()
    const originalCallApi = client.callApi
    const error = rateLimitError()
    originalCallApi.mockRejectedValue(error)
    const wait = jest.fn().mockResolvedValue(undefined)

    installAsanaRateLimitBackoff(client as unknown as ApiClient, wait)
    await expect(
      (client.callApi as unknown as (...a: unknown[]) => Promise<unknown>)(
        ...CALL_ARGS
      )
    ).rejects.toBe(error)

    // One initial attempt plus 5 retries, each preceded by a wait.
    expect(originalCallApi).toHaveBeenCalledTimes(6)
    expect(wait).toHaveBeenCalledTimes(5)
  })

  it('does not retry an error that is not a 429', async () => {
    const client = fakeClient()
    const originalCallApi = client.callApi
    const error = {status: 500}
    originalCallApi.mockRejectedValueOnce(error)
    const wait = jest.fn().mockResolvedValue(undefined)

    installAsanaRateLimitBackoff(client as unknown as ApiClient, wait)
    await expect(
      (client.callApi as unknown as (...a: unknown[]) => Promise<unknown>)(
        ...CALL_ARGS
      )
    ).rejects.toBe(error)

    expect(originalCallApi).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })
})
