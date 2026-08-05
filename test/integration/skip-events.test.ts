import fs from 'fs'
import path from 'path'
import {runAction} from './helpers/harness'
import './setup'

const OPENED_EVENT = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'fixtures/events/pull_request.opened.json'),
    'utf8'
  )
)

describe('events the action ignores', () => {
  it('does nothing for non-PR events', async () => {
    // No Asana interceptors registered at all: any HTTP call the action
    // tried to make would fail against disableNetConnect().
    const {setOutput, setFailed} = await runAction({
      eventName: 'push',
      payload: OPENED_EVENT
    })

    expect(setOutput).not.toHaveBeenCalled()
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('does nothing for PRs titled "Release: ..."', async () => {
    const releasePayload = {
      ...OPENED_EVENT,
      pull_request: {
        ...OPENED_EVENT.pull_request,
        title: 'Release: v1.2.3'
      }
    }

    const {setOutput, setFailed} = await runAction({
      eventName: 'pull_request',
      payload: releasePayload
    })

    expect(setOutput).not.toHaveBeenCalled()
    expect(setFailed).not.toHaveBeenCalled()
  })
})
