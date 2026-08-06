// Jest 27's node test environment doesn't forward the newer fetch globals
// that recent @octokit packages require. Node itself has them (via undici);
// just copy them onto the test environment's global.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {fetch, Headers, Request, Response} = require('undici')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {ReadableStream, WritableStream, TransformStream} = require('node:stream/web')

Object.assign(globalThis, {
  fetch,
  Headers,
  Request,
  Response,
  ReadableStream,
  WritableStream,
  TransformStream
})
