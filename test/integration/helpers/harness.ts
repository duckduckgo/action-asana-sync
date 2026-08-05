import fs from 'fs'
import os from 'os'
import path from 'path'

// Env vars that the harness itself manages across runs, beyond the
// per-test INPUT_* values callers pass in.
const MANAGED_ENV_KEYS = ['GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH']

const DEFAULT_INPUTS: Record<string, string> = {
  ASANA_ACCESS_TOKEN: 'test-asana-token',
  ASANA_WORKSPACE_ID: '1000',
  ASANA_PROJECT_ID: '2000',
  SKIPPED_USERS: '',
  NO_AUTOCLOSE_PROJECTS: '',
  ASSIGN_PR_AUTHOR: 'false',
  USER_MAP: '{}'
}

function inputEnvName(name: string): string {
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`
}

let tmpDir: string | undefined

function writeEventFixture(payload: unknown): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asana-sync-'))
  const file = path.join(tmpDir, 'event.json')
  fs.writeFileSync(file, JSON.stringify(payload))
  return file
}

export interface RunActionOptions {
  /** The GitHub event name, e.g. 'pull_request' or 'pull_request_review'. */
  eventName: string
  /** The webhook payload body for the event. */
  payload: unknown
  /** Action inputs, merged over sensible defaults. */
  inputs?: Record<string, string>
}

export interface RunActionResult {
  core: typeof import('@actions/core')
  setOutput: jest.SpyInstance
  setFailed: jest.SpyInstance
}

/**
 * Loads a fresh copy of src/main.ts (and everything it imports) with the
 * given event payload and inputs wired up via env vars, the same way the
 * real action host would, then waits for it to finish.
 *
 * A fresh module registry per call is required because main.ts reads
 * getInput()/context at import time rather than through an exported
 * entrypoint that takes arguments.
 */
export async function runAction(
  options: RunActionOptions
): Promise<RunActionResult> {
  jest.resetModules()

  const eventPath = writeEventFixture(options.payload)
  process.env.GITHUB_EVENT_NAME = options.eventName
  process.env.GITHUB_EVENT_PATH = eventPath

  const inputs = {...DEFAULT_INPUTS, ...options.inputs}
  for (const [key, value] of Object.entries(inputs)) {
    process.env[inputEnvName(key)] = value
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const core = require('@actions/core')
  const setOutput = jest.spyOn(core, 'setOutput')
  const setFailed = jest.spyOn(core, 'setFailed')
  jest.spyOn(core, 'info').mockImplementation(() => undefined)
  jest.spyOn(core, 'debug').mockImplementation(() => undefined)

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const main = require('../../../src/main')
  await main.done

  return {core, setOutput, setFailed}
}

export function cleanupFixtures(): void {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, {recursive: true, force: true})
    tmpDir = undefined
  }
  for (const key of MANAGED_ENV_KEYS) {
    delete process.env[key]
  }
}
