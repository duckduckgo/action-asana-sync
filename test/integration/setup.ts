import nock from 'nock'
import {jest} from '@jest/globals'
import {cleanupFixtures} from './helpers/harness.js'

const ORIGINAL_ENV = {...process.env}

beforeAll(() => {
  nock.disableNetConnect()
})

beforeEach(() => {
  process.env = {...ORIGINAL_ENV}
})

afterEach(() => {
  nock.cleanAll()
  jest.restoreAllMocks()
  // setFailed() sets process.exitCode; a test exercising the failure path
  // must not leak that into the overall jest process exit code.
  process.exitCode = undefined
})

afterAll(() => {
  nock.enableNetConnect()
  cleanupFixtures()
})
