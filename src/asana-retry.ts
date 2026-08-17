import {ApiClient} from 'asana'
import {info} from '@actions/core'

/**
 * The shape of what `ApiClient.callApi` rejects with. It's the raw superagent
 * error (see node_modules/asana/src/ApiClient.js), which carries the HTTP
 * status and, when the server replied at all, the response - headers
 * included.
 */
interface AsanaApiError {
  status?: number
  response?: {headers?: Record<string, string>}
}

const MAX_RETRIES = 5
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30000

/** Asana sends `Retry-After` in seconds on a 429. */
function retryAfterMs(error: AsanaApiError): number | undefined {
  const header = error.response?.headers?.['retry-after']
  if (!header) return undefined
  const seconds = Number(header)
  return Number.isNaN(seconds) ? undefined : seconds * 1000
}

function backoffDelayMs(attempt: number, error: AsanaApiError): number {
  const retryAfter = retryAfterMs(error)
  if (retryAfter !== undefined) return retryAfter
  const exponential = BASE_DELAY_MS * 2 ** attempt
  const jitter = Math.floor(Math.random() * BASE_DELAY_MS)
  return Math.min(exponential + jitter, MAX_DELAY_MS)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Every Asana API call this action makes - across TasksApi, UsersApi,
 * CustomFieldsApi, SectionsApi, ... - goes through this one method, so
 * wrapping it here retries a rate-limited request for every call site at
 * once. A 429 means Asana rejected the request before doing anything with
 * it, so retrying is always safe here, unlike a 5xx which may have partially
 * applied.
 */
export function installAsanaRateLimitBackoff(
  client: ApiClient = ApiClient.instance,
  wait: (ms: number) => Promise<void> = sleep
): void {
  const originalCallApi = client.callApi.bind(client)
  client.callApi = async function callApiWithBackoff(
    ...args: Parameters<typeof originalCallApi>
  ): ReturnType<typeof originalCallApi> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await originalCallApi(...args)
      } catch (error) {
        const status = (error as AsanaApiError).status
        if (status !== 429 || attempt >= MAX_RETRIES) {
          throw error
        }
        const delay = backoffDelayMs(attempt, error as AsanaApiError)
        info(
          `Asana API rate limit hit (429) on ${args[1]} ${args[0]}. ` +
            `Retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
        )
        await wait(delay)
      }
    }
  }
}
