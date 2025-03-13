import {getInput} from '@actions/core'
import {Octokit} from '@octokit/core'
import yaml from 'js-yaml'

let EXTERNAL_MAPPING_LOADED = false
const USER_MAP: {[key: string]: string} = JSON.parse(
  getInput('USER_MAP', {required: false}) || '{}'
)

async function loadUserMapFromRepo() {
  const GITHUB_TOKEN = getInput('GITHUB_PAT', {required: false})
  if (!GITHUB_TOKEN) {
    return USER_MAP
  }
  const client = new Octokit({auth: GITHUB_TOKEN})
  const owner = 'duckduckgo'
  const repo = 'internal-github-asana-utils'
  const response = await client.request(
    'GET /repos/{owner}/{repo}/contents/user_map.yml',
    {
      owner,
      repo,
      headers: {
        'X-GitHub-Api-Version': '2022-11-28',
        Accept: 'application/vnd.github.raw+json'
      }
    }
  )
  // @ts-expect-error Parsing YAML is untyped
  const userMap: Record<string, string> = yaml.load(response.data)
  for (const username in userMap) {
    USER_MAP[username] = userMap[username]
  }
  EXTERNAL_MAPPING_LOADED = true
  return USER_MAP
}

export async function getUserFromLogin(login: string) {
  if (!EXTERNAL_MAPPING_LOADED) {
    await loadUserMapFromRepo()
  }
  return USER_MAP[login] || undefined
}
