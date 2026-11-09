// Route fetch through the npm undici package rather than Node's bundled copy,
// so the undici MockAgent used in tests intercepts @octokit's requests.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {fetch, Headers, Request, Response} = require('undici')

Object.assign(globalThis, {fetch, Headers, Request, Response})
