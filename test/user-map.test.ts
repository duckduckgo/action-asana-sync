import {test} from 'node:test'
import assert from 'node:assert'
import {getUserFromLogin} from '../src/user-map'

/** Needs to be run with INPUT_GITHUB_PAT environment variable set */
test('getUserFromLogin', async t => {
  assert.equal(await getUserFromLogin('sammacbeth'), '1199184945884326')
})
