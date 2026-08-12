import fs from 'fs'
import os from 'os'
import path from 'path'

/** The workspace every test runs against, and mocks Asana calls for. */
export const WORKSPACE_ID = '1000'

const DEFAULT_INPUTS: Record<string, string> = {
  ASANA_ACCESS_TOKEN: 'test-asana-token',
  ASANA_WORKSPACE_ID: WORKSPACE_ID,
  ASANA_PROJECT_ID: '2000',
  SKIPPED_USERS: '',
  NO_AUTOCLOSE_PROJECTS: '',
  ASSIGN_PR_AUTHOR: 'false',
  USER_MAP: '{}'
}

function inputEnvName(name: string): string {
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`
}

// Reused across every runAction() call in a test file instead of a fresh
// mkdtemp per call: only the file's contents change between calls.
let eventFile: string | undefined

function writeEventFixture(payload: unknown): string {
  if (!eventFile) {
    eventFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'asana-sync-')),
      'event.json'
    )
  }
  fs.writeFileSync(eventFile, JSON.stringify(payload))
  return eventFile
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

  process.env.GITHUB_EVENT_NAME = options.eventName
  process.env.GITHUB_EVENT_PATH = writeEventFixture(options.payload)

  const inputs = {...DEFAULT_INPUTS, ...options.inputs}
  for (const [key, value] of Object.entries(inputs)) {
    process.env[inputEnvName(key)] = value
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const core = require('@actions/core')
  const setOutput = jest.spyOn(core, 'setOutput')
  const setFailed = jest.spyOn(core, 'setFailed')
  jest.spyOn(core, 'info').mockImplementation(() => undefined)
  jest.spyOn(core, 'debug').mockImplementation(() => undefined)

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const main = require('../../../src/main')
  await main.done

  return {core, setOutput, setFailed}
}

/** Removes the shared event-fixture temp dir. Call once, e.g. from afterAll(). */
export function cleanupFixtures(): void {
  if (eventFile) {
    fs.rmSync(path.dirname(eventFile), {recursive: true, force: true})
    eventFile = undefined
  }
}

/**
 * Reads and parses a JSON fixture, given a path relative to test/integration/.
 * Returns `any`, matching JSON.parse(), since these are loosely-typed fixtures
 * callers spread, index into, and mutate freely.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadFixture<T = any>(relativePath: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
  )
}
