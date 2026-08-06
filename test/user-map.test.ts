import {MockAgent, getGlobalDispatcher, setGlobalDispatcher} from 'undici'

const REPO_OWNER = 'duckduckgo'
const REPO_NAME = 'internal-github-asana-utils'

function loadUserMapModule(): typeof import('../src/user-map') {
  jest.resetModules()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../src/user-map')
}

describe('getUserFromLogin', () => {
  const originalEnv = process.env
  const originalDispatcher = getGlobalDispatcher()
  let mockAgent: MockAgent

  beforeEach(() => {
    process.env = {...originalEnv}
    // @octokit/request (used by loadUserMapFromRepo) talks to the Github
    // API over undici's fetch, which nock's classic http-patching API
    // cannot intercept -- undici's own MockAgent is the right tool here.
    mockAgent = new MockAgent()
    mockAgent.disableNetConnect()
    setGlobalDispatcher(mockAgent)
  })

  afterEach(async () => {
    process.env = originalEnv
    setGlobalDispatcher(originalDispatcher)
    await mockAgent.close()
  })

  it('resolves from the USER_MAP input without calling Github when no PAT is set', async () => {
    process.env.INPUT_USER_MAP = JSON.stringify({
      octocat: 'octocat@example.com'
    })
    delete process.env.INPUT_GITHUB_PAT

    const {getUserFromLogin} = loadUserMapModule()

    await expect(getUserFromLogin('octocat')).resolves.toBe(
      'octocat@example.com'
    )
  })

  it('returns undefined for a login missing from the map', async () => {
    process.env.INPUT_USER_MAP = '{}'
    delete process.env.INPUT_GITHUB_PAT

    const {getUserFromLogin} = loadUserMapModule()

    await expect(getUserFromLogin('nobody')).resolves.toBeUndefined()
  })

  it('merges in the mapping fetched from the private repo when GITHUB_PAT is set', async () => {
    process.env.INPUT_USER_MAP = JSON.stringify({
      'local-only-user': 'local@example.com'
    })
    process.env.INPUT_GITHUB_PAT = 'test-pat'

    const pool = mockAgent.get('https://api.github.com')
    pool
      .intercept({
        path: `/repos/${REPO_OWNER}/${REPO_NAME}/contents/user_map.yml`,
        method: 'GET'
      })
      .reply(200, 'sammacbeth: "1199184945884326"\n', {
        headers: {'content-type': 'text/plain; charset=utf-8'}
      })

    const {getUserFromLogin} = loadUserMapModule()

    await expect(getUserFromLogin('sammacbeth')).resolves.toBe(
      '1199184945884326'
    )
    // The locally-supplied USER_MAP input should survive the merge.
    await expect(getUserFromLogin('local-only-user')).resolves.toBe(
      'local@example.com'
    )
  })

  it('only fetches the repo mapping once per process (caches EXTERNAL_MAPPING_LOADED)', async () => {
    process.env.INPUT_GITHUB_PAT = 'test-pat'

    const pool = mockAgent.get('https://api.github.com')
    // No .persist(): a second real request here would throw
    // "Intercepted request ... does not match any registered mock dispatches",
    // which is exactly the "only fetches once" assertion we want.
    pool
      .intercept({
        path: `/repos/${REPO_OWNER}/${REPO_NAME}/contents/user_map.yml`,
        method: 'GET'
      })
      .reply(200, 'sammacbeth: "1199184945884326"\n', {
        headers: {'content-type': 'text/plain; charset=utf-8'}
      })

    const {getUserFromLogin} = loadUserMapModule()

    await expect(getUserFromLogin('sammacbeth')).resolves.toBe(
      '1199184945884326'
    )
    await expect(getUserFromLogin('sammacbeth')).resolves.toBe(
      '1199184945884326'
    )
  })
})
