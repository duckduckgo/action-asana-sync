import {debug, info} from '@actions/core'
import {CustomFieldsApi, CustomFieldSettingsApi} from 'asana'

const CUSTOM_FIELD_NAMES = {
  url: 'Github URL',
  status: 'Github Status'
}

// The `asana` package's published types are untyped (`any`) throughout, so we
// declare a narrow shape here for the fields this action actually reads.
export interface AsanaCustomField {
  gid: string
  name: string
  enum_options?: Array<{gid: string; name: string}>
}

export type PRFields = {
  url: AsanaCustomField
  status: AsanaCustomField
}

interface FoundCustomFields {
  url?: AsanaCustomField
  status?: AsanaCustomField
}

interface AsanaCustomFieldSetting {
  custom_field: AsanaCustomField
}

// The asana client's `Collection` wrapper (returned because
// `ApiClient.instance.RETURN_COLLECTION` defaults to true) exposes `.data`
// for the current page and a `.nextPage()` method that resolves to the next
// `Collection`, or to `{data: null}` once there are no more pages.
interface AsanaCollectionPage<T> {
  data: T[] | null
  nextPage(): Promise<AsanaCollectionPage<T>>
}

const customFieldSettingsApi = new CustomFieldSettingsApi()
const customFieldsApi = new CustomFieldsApi()

/**
 * Lazily yields items across every page of an Asana Collection, fetching
 * each page only once the consumer asks for more of it - so a consumer that
 * finds what it needs partway through never pays for the remaining pages.
 */
async function* iteratePages<T>(
  firstPage: Promise<AsanaCollectionPage<T>> | AsanaCollectionPage<T>
): AsyncGenerator<T> {
  let page = await firstPage
  while (page.data) {
    for (const item of page.data) {
      yield item
    }
    page = await page.nextPage()
  }
}

/** Scans `items` for the two named custom fields, stopping as soon as both are found. */
async function findNamedFields<T>(
  items: AsyncIterable<T>,
  fieldOf: (item: T) => AsanaCustomField
): Promise<FoundCustomFields> {
  const found: FoundCustomFields = {}
  for await (const item of items) {
    const field = fieldOf(item)
    if (field.name === CUSTOM_FIELD_NAMES.url) {
      found.url = field
    } else if (field.name === CUSTOM_FIELD_NAMES.status) {
      found.status = field
    }
    if (found.url && found.status) {
      break
    }
  }
  return found
}

/**
 * Looks for the custom fields attached to the destination project, rather
 * than every custom field in the whole workspace: a workspace can have
 * hundreds of fields spread across many teams, so paging through all of
 * them just to find these two by name is a needlessly expensive call to
 * make on every PR event, and one that's easy to rate-limit.
 */
function findCustomFieldsInProject(
  projectGid: string
): Promise<FoundCustomFields> {
  const settings = iteratePages<AsanaCustomFieldSetting>(
    customFieldSettingsApi.getCustomFieldSettingsForProject(projectGid, {
      limit: 100,
      opt_fields: 'custom_field.name,custom_field.enum_options'
    })
  )
  return findNamedFields(settings, setting => setting.custom_field)
}

/**
 * Falls back to every custom field in the whole workspace, for the case
 * where "Github URL"/"Github Status" exist but were never attached to the
 * destination project's own custom field settings. Only tried once the
 * cheap project-scoped lookup above has come up short, since this can page
 * through hundreds of fields unrelated to this project.
 */
function findCustomFieldsInWorkspace(
  workspaceGid: string
): Promise<FoundCustomFields> {
  const fields = iteratePages<AsanaCustomField>(
    customFieldsApi.getCustomFieldsForWorkspace(workspaceGid, {limit: 100})
  )
  return findNamedFields(fields, field => field)
}

export async function findCustomFields(
  projectGid: string,
  workspaceGid: string
): Promise<PRFields> {
  let {url: githubUrlField, status: githubStatusField} =
    await findCustomFieldsInProject(projectGid)

  if (!githubUrlField || !githubStatusField) {
    info(
      `${CUSTOM_FIELD_NAMES.url}/${CUSTOM_FIELD_NAMES.status} not both found ` +
        `on the project's own custom fields. Falling back to a workspace-wide scan`
    )
    const fromWorkspace = await findCustomFieldsInWorkspace(workspaceGid)
    githubUrlField = githubUrlField || fromWorkspace.url
    githubStatusField = githubStatusField || fromWorkspace.status
  }

  if (!githubUrlField || !githubStatusField) {
    debug(
      `Still missing after the workspace-wide scan: ${[
        !githubUrlField && CUSTOM_FIELD_NAMES.url,
        !githubStatusField && CUSTOM_FIELD_NAMES.status
      ]
        .filter(Boolean)
        .join(', ')}`
    )
    throw new Error('Custom fields are missing. Please create them')
  }
  debug(`${CUSTOM_FIELD_NAMES.url} field GID: ${githubUrlField.gid}`)
  debug(`${CUSTOM_FIELD_NAMES.status} field GID: ${githubStatusField.gid}`)
  return {
    url: githubUrlField,
    status: githubStatusField
  }
}
