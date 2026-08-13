// Jest's node test environment doesn't forward the newer fetch globals that
// recent @octokit packages require. Node itself has them (via undici); just
// copy them onto the test environment's global.
import {ReadableStream, WritableStream, TransformStream} from 'node:stream/web'
import {fetch, Headers, Request, Response} from 'undici'

Object.assign(globalThis, {ReadableStream, WritableStream, TransformStream})
Object.assign(globalThis, {fetch, Headers, Request, Response})
