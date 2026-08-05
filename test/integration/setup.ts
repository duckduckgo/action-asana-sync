import nock from 'nock'
import {cleanupFixtures} from './helpers/harness'

const ORIGINAL_ENV = {...process.env}

beforeAll(() => {
  nock.disableNetConnect()
})

beforeEach(() => {
  process.env = {...ORIGINAL_ENV}
})

afterEach(() => {
  cleanupFixtures()
  nock.cleanAll()
  jest.restoreAllMocks()
  // setFailed() sets process.exitCode; a test exercising the failure path
  // must not leak that into the overall jest process exit code.
  process.exitCode = undefined
})

afterAll(() => {
  nock.enableNetConnect()
})
