import fs from 'fs'
import os from 'os'
import path from 'path'
import {fileURLToPath} from 'url'
import {jest} from '@jest/globals'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// @actions/core's real ES module exports are frozen bindings, so
// jest.spyOn can't reassign them in place the way it could on a CommonJS
// module.exports object. Capture the real implementation first, then swap
// in a mock module -- before main.ts (which statically imports
// '@actions/core') is ever loaded -- that spies on setOutput/setFailed
// while still calling through, and fully silences info/debug.
const actualCore = await import('@actions/core')
const setOutput = jest.fn(actualCore.setOutput)
const setFailed = jest.fn(actualCore.setFailed)
jest.unstable_mockModule('@actions/core', () => ({
  ...actualCore,
  setOutput,
  setFailed,
  info: jest.fn(),
  debug: jest.fn()
}))

// @actions/github's `context` singleton reads GITHUB_EVENT_PATH/NAME once,
// at module-load time -- fine for a real action process, but fatal for
// reusing one module instance across many runAction() calls each writing a
// different event fixture. Mock it with getters that re-read those env vars
// on every access instead, so each call's payload is picked up correctly
// even though the module itself is only ever loaded once per test file.
const actualGithub = await import('@actions/github')
jest.unstable_mockModule('@actions/github', () => ({
  ...actualGithub,
  context: {
    get eventName(): string {
      return process.env.GITHUB_EVENT_NAME ?? ''
    },
    get payload(): unknown {
      const eventPath = process.env.GITHUB_EVENT_PATH
      return eventPath ? JSON.parse(fs.readFileSync(eventPath, 'utf8')) : {}
    }
  }
}))

// src/user-map.ts has the same problem one level down: it snapshots the
// USER_MAP input into a module-level object at load time, so whichever
// runAction() call happens to load it first in this test file would win for
// every later call too. A cache-busted re-import doesn't fix this the way
// it does for main.ts: Jest matches a mock by resolved file path regardless
// of query string, so re-importing this same specifier with a busting query
// just re-enters this same mock factory forever. Read from a plain mutable
// box that runAction() fills in before each call instead. This does mean
// GITHUB_PAT's real-repo-fetch codepath is never exercised here -- fine
// today since no integration test sets GITHUB_PAT, but worth revisiting if
// one starts to.
let currentUserMap: Record<string, string> = {}
jest.unstable_mockModule('../../../src/user-map.js', () => ({
  getUserFromLogin: async (login: string) => currentUserMap[login] || undefined
}))

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
  setOutput: typeof setOutput
  setFailed: typeof setFailed
}

// Jest's ESM module registry isn't cleared by jest.resetModules() the way
// its CommonJS registry is, so a fresh copy of main.ts needs a cache-busting
// import specifier instead. @actions/core itself doesn't need busting: every
// reload of main.ts resolves the same, mocked '@actions/core' registered
// above, so these same setOutput/setFailed mocks keep intercepting calls
// made by each freshly-reloaded main.ts.
let loadCount = 0

/**
 * Loads a fresh copy of src/main.ts (and everything it imports) with the
 * given event payload and inputs wired up via env vars, the same way the
 * real action host would, then waits for it to finish.
 *
 * A fresh module load per call is required because main.ts reads
 * getInput()/context at import time rather than through an exported
 * entrypoint that takes arguments.
 */
export async function runAction(
  options: RunActionOptions
): Promise<RunActionResult> {
  process.env.GITHUB_EVENT_NAME = options.eventName
  process.env.GITHUB_EVENT_PATH = writeEventFixture(options.payload)

  const inputs = {...DEFAULT_INPUTS, ...options.inputs}
  for (const [key, value] of Object.entries(inputs)) {
    process.env[inputEnvName(key)] = value
  }
  currentUserMap = JSON.parse(inputs.USER_MAP || '{}')

  const main = await import(`../../../src/main.js?update=${loadCount++}`)
  await main.done

  return {core: actualCore, setOutput, setFailed}
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
