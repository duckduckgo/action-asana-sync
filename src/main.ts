import asana, {Client} from 'asana'
import {info, setFailed, getInput, debug, setOutput} from '@actions/core'
import {context} from '@actions/github'
import {
  PullRequest,
  PullRequestEvent,
  PullRequestReviewEvent,
  PullRequestReviewRequestedEvent
} from '@octokit/webhooks-types'

import {renderMD} from './markdown'
import {getUserFromLogin} from './user-map'

const CUSTOM_FIELD_NAMES = {
  url: 'Github URL',
  status: 'Github Status'
}

type PRState = 'Open' | 'Closed' | 'Merged' | 'Approved' | 'Draft'

type PRFields = {
  url: asana.resources.CustomField
  status: asana.resources.CustomField
}
const client = Client.create({
  defaultHeaders: {
    'asana-enable':
      'new_user_task_lists,new_project_templates,new_goal_memberships'
  }
}).useAccessToken(getInput('ASANA_ACCESS_TOKEN', {required: true}))
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

async function createOrReopenReviewSubtask(
  taskId: string,
  reviewer: string,
  subtasks: asana.resources.ResourceList<asana.resources.Tasks.Type>
): Promise<asana.resources.Tasks.Type | null> {
  const payload = context.payload as PullRequestEvent
  const title = payload.pull_request.title
  //  const subtasks = await client.tasks.subtasks(taskId)
  const githubAuthor = payload.pull_request.user.login
  const author = await getUserFromLogin(githubAuthor)
  const reviewerGidOrEmail = await getUserFromLogin(reviewer)
  info(`Review requested from ${reviewer} (${reviewerGidOrEmail})`)
  if (
    SKIPPED_USERS_LIST.includes(reviewer) ||
    reviewerGidOrEmail === undefined
  ) {
    info(
      `Skipping review subtask creation for ${reviewer} - member of SKIPPED_USERS`
    )
    return null
  }

  let reviewSubtask
  for (let subtask of subtasks.data) {
    info(`Checking subtask ${subtask.gid} assignee`)
    subtask = await client.tasks.findById(subtask.gid)
    if (!subtask.assignee) {
      info(`Task ${subtask.gid} has no assignee`)
      continue
    }
    const asanaUser = await client.users.findById(subtask.assignee.gid)
    if (
      asanaUser.email === reviewerGidOrEmail ||
      asanaUser.gid === reviewerGidOrEmail
    ) {
      info(
        `Found existing review task for ${subtask.gid} and ${asanaUser.email}`
      )
      reviewSubtask = subtask
      break
    }
  }
  info(`Subtask for ${reviewer}: ${JSON.stringify(reviewSubtask)}`)
  const taskFollowers = [reviewerGidOrEmail]
  if (author !== undefined) {
    taskFollowers.push(author)
  }
  const subtaskObj = {
    name: `Review Request: ${title}`,
    notes: `${author || githubAuthor} requested your code review of ${
      payload.pull_request.html_url
    }.

NOTE:
* This task will be automatically closed when the review is completed in Github

See parent task for more information`,
    assignee: reviewerGidOrEmail,
    followers: taskFollowers
  }
  if (!reviewSubtask) {
    info(`Author: ${author}`)
    info(
      `Creating review subtask for ${reviewer}: ${JSON.stringify(subtaskObj)}`
    )
    info(`Creating new subtask can fail when too many subtasks are nested!`)
    reviewSubtask = await client.tasks.addSubtask(taskId, subtaskObj)
  } else {
    info(`Reopening a review subtask for ${reviewer}`)
    // TODO add a comment?
    await client.tasks.updateTask(reviewSubtask.gid, {completed: false})
  }
  return reviewSubtask
}

async function updateReviewSubTasks(taskId: string): Promise<void> {
  info(`Creating/updating review subtasks for task ${taskId}`)
  const payload = context.payload as PullRequestEvent
  const subtasks = await client.tasks.subtasks(taskId)
  if (
    context.eventName === 'pull_request' ||
    context.eventName === 'pull_request_target'
  ) {
    if (payload.action === 'review_requested') {
      const requestPayload = payload as PullRequestReviewRequestedEvent
      // TODO handle teams?
      if ('requested_reviewer' in requestPayload) {
        createOrReopenReviewSubtask(
          taskId,
          requestPayload.requested_reviewer.login,
          subtasks
        )
      }
    }
  } else if (context.eventName === 'pull_request_review') {
    const reviewPayload = context.payload as PullRequestReviewEvent
    if (
      reviewPayload.action === 'submitted' &&
      reviewPayload.review.state === 'approved'
    ) {
      const reviewer = reviewPayload.review.user
      info(`PR approved by ${reviewer.login}. Updating review subtask.`)
      const subtask = await createOrReopenReviewSubtask(
        taskId,
        reviewer.login,
        subtasks
      )
      if (subtask !== null) {
        info(`Completing review subtask for ${reviewer.login}: ${subtask.gid}`)
        await client.tasks.updateTask(subtask.gid, {completed: true})
      }
    }
  }
}

async function closeSubtasks(taskId: string) {
  const subtasks = await client.tasks.subtasks(taskId)

  for (const subtask of subtasks.data) {
    await client.tasks.updateTask(subtask.gid, {completed: true})
  }
}

async function findPRTask(
  customFields: PRFields
): Promise<asana.resources.Tasks.Type | null> {
  // Let's first try to seaech using PR URL
  const payload = context.payload as PullRequestEvent
  const prURL = payload.pull_request.html_url

  const prTasks = await client.tasks.searchInWorkspace(ASANA_WORKSPACE_ID, {
    [`custom_fields.${customFields.url.gid}.value`]: prURL
  })
  if (prTasks.data.length > 0) {
    info(`Found PR task using searchInWorkspace: ${prTasks.data[0].gid}`)
    return prTasks.data[0]
  } else {
    // searchInWorkspace can fail for recently created Asana tasks. Let's look
    // at 100 most recent tasks in destination project
    // https://developers.asana.com/reference/searchtasksforworkspace#eventual-consistency
    const projectTasks = await client.tasks.findByProject(PROJECT_ID, {
      // eslint-disable-next-line camelcase
      opt_fields: 'custom_fields',
      limit: 100
    })

    for (const task of projectTasks.data) {
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
): Promise<asana.resources.Tasks.Type> {
  const payload = context.payload as PullRequestEvent
  info(`Creating new PR task for PR from ${payload.pull_request.user.login}`)
  const taskObjBase = {
    workspace: ASANA_WORKSPACE_ID,
    // eslint-disable-next-line camelcase
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

  const asanaTaskMatch = notes.match(/https:\/\/app.asana.*\/([0-9]+).*/)
  if (asanaTaskMatch) {
    info(`Found Asana task mention with parent ID: ${asanaTaskMatch[1]}`)
    const parentID = asanaTaskMatch[1]
    parentObj = {parent: parentID}

    // Verify we can access parent or we can't add it
    try {
      await client.tasks.findById(parentID)
    } catch (e) {
      info(`Can't access parent task: ${parentID}: ${e}`)
      info(`Add 'dax' user to respective projects to enable this feature`)
      parentObj = {}
    }
  }

  return client.tasks.create({...taskObjBase, ...parentObj})
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
    const customFields = await findCustomFields(ASANA_WORKSPACE_ID)

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
      const maxRetries = 5
      let retries = 0

      while (retries < maxRetries) {
        // Wait for PR to appear
        task = await findPRTask(customFields)
        if (task) {
          setOutput('result', 'updated')
          break
        }
        info(`PR task not found yet. Sleeping...`)
        await new Promise(resolve => setTimeout(resolve, 20000))
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
      await client.sections.addTask(sectionId, {task: task.gid})
    }
    const taskId = task.gid
    // Whether we want to close the PR task
    let closeTask = false

    // Handle PR close events (merged/closed)
    if (['closed'].includes(payload.pull_request.state)) {
      info(`Pull request closed. Closing any remaining subtasks`)
      // Close any remaining review tasks when PR is merged
      closeSubtasks(taskId)

      // Unless the task is in specific projects automatically close
      closeTask = true
      info(`Considering whether to close PR task itself...`)
      const fullTask = await client.tasks.findById(taskId)
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
      await client.tasks.updateTask(taskId, {
        name: title,
        // eslint-disable-next-line camelcase
        html_notes: htmlNotes,
        completed: closeTask,
        // eslint-disable-next-line camelcase
        custom_fields: {
          [customFields.status.gid]: statusGid
        }
      })
    } catch (err) {
      info(`Updating task with HTML notes failed. Retrying with plaintext`)
      await client.tasks.updateTask(taskId, {
        name: title,
        notes,
        completed: closeTask,
        // eslint-disable-next-line camelcase
        custom_fields: {
          [customFields.status.gid]: statusGid
        }
      })
    }
  } catch (error) {
    if (error instanceof Error)
      setFailed(`${error.message}\nStacktrace:\n${error.stack}`)
  }
}

async function findCustomFields(workspaceGid: string): Promise<PRFields> {
  const apiResponse = await client.customFields.getCustomFieldsForWorkspace(
    workspaceGid
  )
  // pull all fields from the API with the streaming
  const stream = apiResponse.stream()
  const customFields: asana.resources.CustomFields.Type[] = []
  stream.on('data', field => {
    customFields.push(field)
  })
  await new Promise<void>(resolve => stream.on('end', resolve))

  const githubUrlField = customFields.find(
    f => f.name === CUSTOM_FIELD_NAMES.url
  )
  const githubStatusField = customFields.find(
    f => f.name === CUSTOM_FIELD_NAMES.status
  )
  if (!githubUrlField || !githubStatusField) {
    debug(JSON.stringify(customFields))
    throw new Error('Custom fields are missing. Please create them')
  } else {
    debug(`${CUSTOM_FIELD_NAMES.url} field GID: ${githubUrlField?.gid}`)
    debug(`${CUSTOM_FIELD_NAMES.status} field GID: ${githubStatusField?.gid}`)
  }
  return {
    url: githubUrlField as asana.resources.CustomField,
    status: githubStatusField as asana.resources.CustomField
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

run()
