import {
  ApiClient,
  CustomFieldsApi,
  CustomFieldSettingsApi,
  SectionsApi,
  TasksApi
} from 'asana'
import {info, setFailed, getInput, debug, setOutput} from '@actions/core'
import {context} from '@actions/github'
import {
  PullRequest,
  PullRequestEvent,
  PullRequestReviewEvent,
  PullRequestReviewRequestedEvent
} from '@octokit/webhooks-types'

import {installAsanaRateLimitBackoff} from './asana-retry'
import {outcomeForReview, ReviewOutcome} from './approvals'
import {renderMD} from './markdown'
import {getReviewerLogins} from './reviewers'
import {getUserFromLogin} from './user-map'

const CUSTOM_FIELD_NAMES = {
  url: 'Github URL',
  status: 'Github Status'
}

type PRState = 'Open' | 'Closed' | 'Merged' | 'Approved' | 'Draft'

// The `asana` package's published types are untyped (`any`) throughout, so we
// declare narrow shapes here for the fields this action actually reads/writes.
interface AsanaCustomField {
  gid: string
  name: string
  enum_options?: Array<{gid: string; name: string}>
}

interface AsanaTask {
  gid: string
  permalink_url: string
  completed?: boolean
  // `default_task` for a normal task, `approval` for an approval task. Part of
  // Asana's compact task representation, so it comes back from subtask
  // listings, but request it via opt_fields where the value is load-bearing.
  resource_subtype?: string
  // `email` isn't part of the default compact assignee representation, so it
  // only comes back where opt_fields asks for `assignee.email` explicitly.
  assignee?: {gid: string; email?: string} | null
  memberships: Array<{project: {gid: string}}>
  custom_fields: Array<{gid: string; display_value: string}>
}

type PRFields = {
  url: AsanaCustomField
  status: AsanaCustomField
}

ApiClient.instance.authentications.token.accessToken = getInput(
  'ASANA_ACCESS_TOKEN',
  {required: true}
)
ApiClient.instance.defaultHeaders = {
  'asana-enable':
    'new_user_task_lists,new_project_templates,new_goal_memberships'
}
// Every Asana call this action makes goes through this one client, so a
// single retry-on-429 wrapper here covers all of them.
installAsanaRateLimitBackoff()
export const tasksApi = new TasksApi()
const customFieldSettingsApi = new CustomFieldSettingsApi()
const customFieldsApi = new CustomFieldsApi()
const sectionsApi = new SectionsApi()
const ASANA_WORKSPACE_ID = getInput('ASANA_WORKSPACE_ID', {required: true})
const PROJECT_ID = getInput('ASANA_PROJECT_ID', {required: true})
// Users which will not receive PRs/reviews tasks
const SKIPPED_USERS = getInput('SKIPPED_USERS')
const SKIPPED_USERS_LIST = SKIPPED_USERS.split(',')

// Handle list of projects where we don't want to automatically close tasks
const NO_AUTOCLOSE_PROJECTS = getInput('NO_AUTOCLOSE_PROJECTS')
const NO_AUTOCLOSE_LIST = NO_AUTOCLOSE_PROJECTS.split(',')

// Optional behavior flags
const ASSIGN_PR_AUTHOR = getInput('ASSIGN_PR_AUTHOR') === 'true'
// Create review subtasks for assignees as well as for requested reviewers
const INCLUDE_ASSIGNEES = getInput('INCLUDE_ASSIGNEES') === 'true'
// Create review subtasks as Asana approval tasks. This only affects tasks we
// create: how an existing review subtask is updated is decided by that task's
// own resource_subtype, so review subtasks that predate this option keep the
// plain completed/not-completed behaviour they were created with.
const REVIEW_TASKS_AS_APPROVALS =
  getInput('REVIEW_TASKS_AS_APPROVALS') === 'true'

/**
 * Records a review verdict on a review subtask.
 *
 * For an approval task, `approval_status` and `completed` are the same piece of
 * state: Asana keeps them in sync, so `changes_requested` completes the task and
 * completing a task means `approved`. Writing `approval_status` alone is enough
 * - Asana derives `completed` from it - and it must be written alone: sending
 * `completed` in the same request as `approval_status` gets rejected with a 400,
 * even when the two agree on the same outcome (observed in production against a
 * freshly created approval subtask). For a plain task there is only `completed`,
 * which is what this action has always written.
 */
async function setReviewOutcome(
  subtask: AsanaTask,
  outcome: ReviewOutcome
): Promise<void> {
  const data =
    subtask.resource_subtype === 'approval'
      ? {approval_status: outcome}
      : {completed: outcome !== 'pending'}
  info(`Setting review subtask ${subtask.gid} to ${JSON.stringify(data)}`)
  try {
    await tasksApi.updateTask({data}, subtask.gid)
  } catch (e) {
    const body = (e as {response?: {text?: string}}).response?.text
    info(`Setting review outcome failed: ${e}${body ? ` - ${body}` : ''}`)
    throw e
  }
}

// Whether this Asana plan supports approvals is a property of the workspace, so
// once a create has been refused for that reason, the rest of this run can skip
// straight to creating plain tasks.
let approvalsUnsupported = false

/**
 * Whether a failed create tells us approvals will never be accepted, as opposed
 * to "not right now". A rate limit or a server error says nothing about the
 * plan, and must not make the rest of the run give up on approvals: nothing
 * converts a plain subtask afterwards, so those reviewers would lose approval
 * status for the whole PR.
 */
function meansApprovalsUnsupported(e: unknown): boolean {
  const status = (e as {status?: number}).status
  return status !== undefined && status >= 400 && status < 500 && status !== 429
}

/**
 * Creates a review subtask, as an approval task where that is enabled.
 * Approvals need an Asana plan that supports them, so a rejected create is
 * retried as a plain task rather than failing the review sync outright. The
 * approval wording is only used on a task that really is an approval.
 */
async function createReviewSubtask(
  taskId: string,
  subtaskObj: Record<string, unknown>,
  approvalHtmlNotes: string
): Promise<AsanaTask> {
  info(`Creating new subtask can fail when too many subtasks are nested!`)
  const create = async (data: Record<string, unknown>): Promise<AsanaTask> =>
    (await tasksApi.createSubtaskForTask({data}, taskId)).data
  if (!REVIEW_TASKS_AS_APPROVALS || approvalsUnsupported) {
    return create(subtaskObj)
  }
  try {
    return await create({
      ...subtaskObj,
      html_notes: approvalHtmlNotes,
      resource_subtype: 'approval',
      approval_status: 'pending'
    })
  } catch (e) {
    info(`Creating an approval subtask failed: ${e}`)
    info(`Retrying as a plain task. Does this Asana plan support approvals?`)
    if (meansApprovalsUnsupported(e)) {
      approvalsUnsupported = true
    }
    return create(subtaskObj)
  }
}

/**
 * Resolves a Github login to the Asana user (gid or email) whose review task we
 * should act on, or undefined if this reviewer should be skipped.
 */
async function resolveReviewer(reviewer: string): Promise<string | undefined> {
  const reviewerGidOrEmail = await getUserFromLogin(reviewer)
  info(`Resolved reviewer ${reviewer} to ${reviewerGidOrEmail}`)
  if (
    SKIPPED_USERS_LIST.includes(reviewer) ||
    reviewerGidOrEmail === undefined
  ) {
    info(`Skipping ${reviewer} - unmapped, or a member of SKIPPED_USERS`)
    return undefined
  }
  return reviewerGidOrEmail
}

/**
 * Finds the subtask assigned to the given Asana user, if there is one.
 * Relies on the caller having fetched `assignee` (and `assignee.email`) up
 * front via opt_fields on the subtask listing - the assignee a subtask
 * search would otherwise need a `getTask` and a `getUser` call per subtask
 * to learn.
 */
function findSubtaskForAssignee(
  subtasks: AsanaTask[],
  assigneeGidOrEmail: string
): AsanaTask | undefined {
  const subtask = subtasks.find(
    s =>
      s.assignee?.gid === assigneeGidOrEmail ||
      s.assignee?.email === assigneeGidOrEmail
  )
  if (subtask) {
    info(`Found existing review task ${subtask.gid} for ${assigneeGidOrEmail}`)
  }
  return subtask
}

export async function createOrReopenReviewSubtask(
  taskId: string,
  reviewer: string,
  subtasks: AsanaTask[],
  reopenIfCompleted = true
): Promise<AsanaTask | null> {
  const payload = context.payload as PullRequestEvent
  const title = payload.pull_request.title
  const githubAuthor = payload.pull_request.user.login
  const author = (await getUserFromLogin(githubAuthor)) || githubAuthor
  const reviewerGidOrEmail = await resolveReviewer(reviewer)
  if (!reviewerGidOrEmail) {
    return null
  }

  let reviewSubtask = findSubtaskForAssignee(subtasks, reviewerGidOrEmail)
  info(`Subtask for ${reviewer}: ${JSON.stringify(reviewSubtask)}`)
  const taskFollowers = [reviewerGidOrEmail]
  if (
    author !== undefined &&
    (/^[0-9]+$/.exec(author) !== null || author.includes('@'))
  ) {
    taskFollowers.push(author)
  }
  const requesterName =
    /^[0-9]+$/.exec(author || '') !== null
      ? `<a data-asana-gid="${author}" />`
      : author
  const htmlNotes = (closingNote: string): string =>
    `<body>${requesterName} requested your code review of <a href="${payload.pull_request.html_url}">${payload.pull_request.html_url}</a>.

NOTE:
${closingNote}

See parent task for more information</body>`
  const subtaskObj = {
    name: `Review Request: ${title}`,
    html_notes: htmlNotes(
      `* This task will be automatically closed when the review is completed in Github`
    ),
    assignee: reviewerGidOrEmail,
    followers: taskFollowers
  }
  if (!reviewSubtask) {
    info(`Author: ${author}`)
    info(
      `Creating review subtask for ${reviewer}: ${JSON.stringify(subtaskObj)}`
    )
    reviewSubtask = await createReviewSubtask(
      taskId,
      subtaskObj,
      htmlNotes(
        `* This task's approval status will be set automatically from your review in Github`
      )
    )
  } else if (!reviewSubtask.completed) {
    info(`Review subtask for ${reviewer} is already open`)
  } else if (reopenIfCompleted) {
    info(`Reopening a review subtask for ${reviewer}`)
    // TODO add a comment?
    await setReviewOutcome(reviewSubtask, 'pending')
  } else {
    info(`Leaving the completed review subtask for ${reviewer} as it is`)
  }
  return reviewSubtask
}

async function updateReviewSubTasks(taskId: string): Promise<void> {
  info(`Creating/updating review subtasks for task ${taskId}`)
  const payload = context.payload as PullRequestEvent
  // resource_subtype and completed are what decide whether a subtask can
  // record a given outcome, and assignee/assignee.email are what
  // findSubtaskForAssignee() matches a reviewer against - reading all of
  // them with the listing avoids a getTask+getUser call per subtask to look
  // each one up individually.
  const subtasks = (
    await tasksApi.getSubtasksForTask(taskId, {
      opt_fields: 'resource_subtype,completed,assignee,assignee.email'
    })
  ).data as AsanaTask[]
  if (
    context.eventName === 'pull_request' ||
    context.eventName === 'pull_request_target'
  ) {
    // The reviewer named by a review_requested event is the only one whose
    // completed task may be reopened: a review has just been asked for again.
    // Everyone else keeps the verdict they already gave, so that a later push
    // does not reopen a review that has been given.
    let requestedReviewer: string | undefined
    if (payload.action === 'review_requested') {
      const requestPayload = payload as PullRequestReviewRequestedEvent
      // TODO handle teams?
      if ('requested_reviewer' in requestPayload) {
        requestedReviewer = requestPayload.requested_reviewer.login
      }
    }

    if (INCLUDE_ASSIGNEES) {
      for (const reviewer of getReviewerLogins(payload.pull_request)) {
        await createOrReopenReviewSubtask(
          taskId,
          reviewer,
          subtasks,
          reviewer === requestedReviewer
        )
      }
    } else if (requestedReviewer) {
      await createOrReopenReviewSubtask(taskId, requestedReviewer, subtasks)
    }
  } else if (context.eventName === 'pull_request_review') {
    const reviewPayload = context.payload as PullRequestReviewEvent
    const reviewer = reviewPayload.review.user
    const outcome = outcomeForReview(
      reviewPayload.action,
      reviewPayload.review.state
    )
    info(
      `Review ${reviewPayload.action} by ${reviewer.login} (${reviewPayload.review.state}) -> ${outcome}`
    )
    if (outcome === 'pending') {
      // Nothing was decided - a comment, or a review that was dismissed. Only a
      // decided approval task can go back to being outstanding: a plain review
      // subtask keeps the behaviour it has always had, where an approval is the
      // only thing that closes it, and nothing is created for a non-verdict.
      // Narrowing the candidates first also keeps the common case - a comment on
      // a project with no approvals - down to no extra requests at all.
      const decidedApprovals = subtasks.filter(
        subtask => subtask.resource_subtype === 'approval' && subtask.completed
      )
      if (decidedApprovals.length === 0) {
        info(`No decided approval subtask to reopen`)
        return
      }
      const reviewerGidOrEmail = await resolveReviewer(reviewer.login)
      if (!reviewerGidOrEmail) {
        return
      }
      const subtask = findSubtaskForAssignee(
        decidedApprovals,
        reviewerGidOrEmail
      )
      if (subtask) {
        await setReviewOutcome(subtask, 'pending')
      }
      return
    }
    // The verdict below is the only write this needs, so don't let the
    // find-or-create reopen the task first: that would cost a second request and
    // flap the reviewer's approval through `pending` on its way to the verdict.
    const subtask = await createOrReopenReviewSubtask(
      taskId,
      reviewer.login,
      subtasks,
      false
    )
    if (subtask !== null) {
      await setReviewOutcome(subtask, outcome)
    }
  }
}

// Asana will not let an approval task be completed without its status becoming
// `approved`, so this is what closing an outstanding review has to write.
const OUTCOME_ON_PR_CLOSE: ReviewOutcome = 'approved'

async function closeSubtasks(taskId: string) {
  const subtasks = (
    await tasksApi.getSubtasksForTask(taskId, {
      opt_fields: 'resource_subtype,completed'
    })
  ).data as AsanaTask[]

  for (const subtask of subtasks) {
    if (subtask.completed) {
      // A review that already has a verdict keeps it: completing it again would
      // overwrite a reviewer's "changes requested" with `approved`.
      info(`Subtask ${subtask.gid} is already completed. Leaving it alone`)
      continue
    }
    await setReviewOutcome(subtask, OUTCOME_ON_PR_CLOSE)
  }
}

async function findPRTask(customFields: PRFields): Promise<AsanaTask | null> {
  // Let's first try to seaech using PR URL
  const payload = context.payload as PullRequestEvent
  const prURL = payload.pull_request.html_url

  const searchOpts: Record<string, string> = {
    [`custom_fields.${customFields.url.gid}.value`]: prURL
  }
  const prTasks = (
    await tasksApi.searchTasksForWorkspace(ASANA_WORKSPACE_ID, searchOpts)
  ).data as AsanaTask[]
  if (prTasks.length > 0) {
    info(`Found PR task using searchTasksForWorkspace: ${prTasks[0].gid}`)
    return prTasks[0]
  } else {
    // searchTasksForWorkspace can fail for recently created Asana tasks. Let's
    // look at 100 most recent tasks in destination project
    // https://developers.asana.com/reference/searchtasksforworkspace#eventual-consistency
    const projectTasks = (
      await tasksApi.getTasksForProject(PROJECT_ID, {
        opt_fields: 'custom_fields',
        limit: 100
      })
    ).data as AsanaTask[]

    for (const task of projectTasks) {
      info(`Checking task ${task.gid} for PR link`)
      for (const field of task.custom_fields) {
        if (
          field.gid === customFields.url.gid &&
          field.display_value === prURL
        ) {
          info(`Found existing task ID ${task.gid} for PR ${prURL}`)
          return task
        }
      }
    }
  }
  info(`No matching Asana task found for PR ${prURL}`)
  return null
}

async function createPRTask(
  title: string,
  notes: string,
  prStatus: string,
  customFields: PRFields
): Promise<AsanaTask> {
  const payload = context.payload as PullRequestEvent
  info(`Creating new PR task for PR from ${payload.pull_request.user.login}`)
  const taskObjBase = {
    workspace: ASANA_WORKSPACE_ID,
    custom_fields: {
      [customFields.url.gid]: payload.pull_request.html_url,
      [customFields.status.gid]: prStatus
    },
    notes,
    name: title,
    projects: [PROJECT_ID],
    assignee: ASSIGN_PR_AUTHOR
      ? await getUserFromLogin(payload.pull_request.user.login)
      : undefined
  }
  if (taskObjBase.assignee) {
    info(`Task will be assigned to ${taskObjBase.assignee}`)
  }
  let parentObj = {}

  const asanaTaskMatch = notes.match(/[ *:]https:\/\/app.asana.*\/([0-9]+)/)
  if (asanaTaskMatch) {
    info(`Found Asana task mention with parent ID: ${asanaTaskMatch[1]}`)
    const parentID = asanaTaskMatch[1]
    parentObj = {parent: parentID}

    // Verify we can access parent or we can't add it
    try {
      await tasksApi.getTask(parentID)
    } catch (e) {
      info(`Can't access parent task: ${parentID}: ${e}`)
      info(`Add 'dax' user to respective projects to enable this feature`)
      parentObj = {}
    }
  }

  return (await tasksApi.createTask({data: {...taskObjBase, ...parentObj}}))
    .data
}

async function run(): Promise<void> {
  try {
    debug(`Event: ${context.eventName}.`)
    if (
      !['pull_request', 'pull_request_target', 'pull_request_review'].includes(
        context.eventName
      )
    ) {
      info('Only runs for PR changes and reviews')
      return
    }

    debug(`Event JSON: \n${JSON.stringify(context, null, 2)}`)
    const payload = context.payload as PullRequestEvent
    // Skip any action on PRs with this title
    if (payload.pull_request.title.startsWith('Release: ')) {
      info(`Skipping Asana sync for release PR`)
      return
    }

    const htmlUrl = payload.pull_request.html_url
    info(`PR url: ${htmlUrl}`)
    info(`Action: ${payload.action}`)
    const customFields = await findCustomFields(PROJECT_ID, ASANA_WORKSPACE_ID)

    // PR metadata
    const statusGid =
      customFields.status.enum_options?.find(
        f => f.name === getPRState(payload.pull_request)
      )?.gid || ''
    const title = `PR ${payload.repository.name} #${payload.pull_request.number}: ${payload.pull_request.title}`
    const body = payload.pull_request.body || 'Empty description'

    const preamble = `**Note:** This description is automatically updated from Github. **Changes will be LOST**.

Code reviews will be created as subtasks and assigned to reviewers.

PR: ${htmlUrl}`

    // Asana has limits on size of notes. Let's be very conservative and trim the text
    const truncatedBody = (
      body.length > 5000 ? `${body.slice(0, 5000)}…` : body
    ).replace(/^---$[\s\S]*/gm, '')

    // Unformatted plaintext notes for fallback
    const notes = `
${preamble}

${truncatedBody}`

    // Rich-text notes with some custom "fixes" for Asana to render things
    const htmlNotes = `<body>${renderMD(notes)}</body>`

    let task
    if (['opened'].includes(payload.action)) {
      task = await createPRTask(title, notes, statusGid, customFields)
      setOutput('result', 'created')
    } else {
      const maxRetries = 3 + Math.floor(Math.random() * 5) // 3-8 retries
      let retries = 0

      while (retries < maxRetries) {
        // Wait for PR to appear
        task = await findPRTask(customFields)
        if (task) {
          setOutput('result', 'updated')
          break
        }
        info(`PR task not found yet. Sleeping...`)
        await new Promise(resolve =>
          setTimeout(resolve, 20000 + Math.floor(Math.random() * 10000))
        ) // 20-30s wait time
        retries++
      }

      if (!task) {
        info(
          `Waited a long time and no task appeared. Assuming old PR and creating a new task.`
        )
        task = await createPRTask(title, notes, statusGid, customFields)
        setOutput('result', 'created')
      }
    }

    setOutput('task_url', task.permalink_url)
    const sectionId = getInput('move_to_section_id')
    if (sectionId) {
      await sectionsApi.addTaskForSection(sectionId, {
        body: {data: {task: task.gid}}
      })
    }
    const taskId = task.gid
    // Whether we want to close the PR task
    let closeTask = false

    // Handle PR close events (merged/closed)
    if (['closed'].includes(payload.pull_request.state)) {
      info(`Pull request closed. Closing any remaining subtasks`)
      // Close any remaining review tasks when PR is merged
      await closeSubtasks(taskId)

      // Unless the task is in specific projects automatically close
      closeTask = true
      info(`Considering whether to close PR task itself...`)
      const fullTask = (await tasksApi.getTask(taskId)).data as AsanaTask
      for (const membership of fullTask.memberships) {
        if (NO_AUTOCLOSE_LIST.includes(membership.project.gid)) {
          info(`Tasks is in one of NO_AUTOCLOSE_PROJECTS. Not closing`)
          closeTask = false
        }
      }
    } else {
      await updateReviewSubTasks(taskId)
    }

    try {
      // Try using html notes first and fall back to unformatted if this fails
      await tasksApi.updateTask(
        {
          data: {
            name: title,
            html_notes: htmlNotes,
            completed: closeTask,
            custom_fields: {
              [customFields.status.gid]: statusGid
            }
          }
        },
        taskId
      )
    } catch (err) {
      info(`Updating task with HTML notes failed. Retrying with plaintext`)
      await tasksApi.updateTask(
        {
          data: {
            name: title,
            notes,
            completed: closeTask,
            custom_fields: {
              [customFields.status.gid]: statusGid
            }
          }
        },
        taskId
      )
    }
  } catch (error) {
    if (error instanceof Error)
      setFailed(`${error.message}\nStacktrace:\n${error.stack}`)
  }
}

// The asana client's `Collection` wrapper (returned because
// `ApiClient.instance.RETURN_COLLECTION` defaults to true) exposes `.data`
// for the current page and a `.nextPage()` method that resolves to the next
// `Collection`, or to `{data: null}` once there are no more pages.
interface AsanaCollectionPage<T> {
  data: T[] | null
  nextPage(): Promise<AsanaCollectionPage<T>>
}

interface AsanaCustomFieldSetting {
  custom_field: AsanaCustomField
}

/** Collects every page of an Asana Collection into a single array. */
async function collectAllPages<T>(
  firstPage: Promise<AsanaCollectionPage<T>> | AsanaCollectionPage<T>
): Promise<T[]> {
  const items: T[] = []
  let page = await firstPage
  while (page.data) {
    items.push(...page.data)
    page = await page.nextPage()
  }
  return items
}

/**
 * Lists the custom fields attached to the destination project, rather than
 * every custom field in the whole workspace: a workspace can have hundreds of
 * fields spread across many teams, so paging through all of them just to
 * find these two by name is a needlessly expensive call to make on every PR
 * event, and one that's easy to rate-limit.
 */
async function getCustomFieldsForProject(
  projectGid: string
): Promise<AsanaCustomField[]> {
  const settings = await collectAllPages<AsanaCustomFieldSetting>(
    customFieldSettingsApi.getCustomFieldSettingsForProject(projectGid, {
      limit: 100,
      opt_fields: 'custom_field.name,custom_field.enum_options'
    })
  )
  return settings.map(setting => setting.custom_field)
}

/**
 * Falls back to every custom field in the whole workspace, for the case
 * where "Github URL"/"Github Status" exist but were never attached to the
 * destination project's own custom field settings. Only tried once the
 * cheap project-scoped lookup above has come up short, since this can page
 * through hundreds of fields unrelated to this project.
 */
async function getAllCustomFieldsForWorkspace(
  workspaceGid: string
): Promise<AsanaCustomField[]> {
  return collectAllPages<AsanaCustomField>(
    customFieldsApi.getCustomFieldsForWorkspace(workspaceGid, {limit: 100})
  )
}

interface FoundCustomFields {
  url?: AsanaCustomField
  status?: AsanaCustomField
}

function pickCustomFields(customFields: AsanaCustomField[]): FoundCustomFields {
  return {
    url: customFields.find(f => f.name === CUSTOM_FIELD_NAMES.url),
    status: customFields.find(f => f.name === CUSTOM_FIELD_NAMES.status)
  }
}

async function findCustomFields(
  projectGid: string,
  workspaceGid: string
): Promise<PRFields> {
  let {url: githubUrlField, status: githubStatusField} = pickCustomFields(
    await getCustomFieldsForProject(projectGid)
  )

  if (!githubUrlField || !githubStatusField) {
    info(
      `${CUSTOM_FIELD_NAMES.url}/${CUSTOM_FIELD_NAMES.status} not both found ` +
        `on the project's own custom fields. Falling back to a workspace-wide scan`
    )
    const fromWorkspace = pickCustomFields(
      await getAllCustomFieldsForWorkspace(workspaceGid)
    )
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

function getPRState(pr: PullRequest): PRState {
  if (pr.merged) {
    return 'Merged'
  }
  if (pr.state === 'open') {
    if (pr.draft) {
      return 'Draft'
    }
    return 'Open'
  }
  return 'Closed'
}

export const done = run()
