// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Overrides = Record<string, any>

// Every call site passes an explicit `gid`, since it must match the gid
// baked into the corresponding nock URL, so these factories don't default it.

export function makeTask(overrides: Overrides): Overrides {
  return {
    name: 'A task',
    permalink_url: 'https://app.asana.com/0/2000/9999',
    memberships: [],
    ...overrides
  }
}

export function makeUser(overrides: Overrides): Overrides {
  return {
    email: 'user@example.com',
    name: 'A User',
    ...overrides
  }
}

// Defaults to a plain task: an approval subtask only exists where a test (or
// the action, with REVIEW_TASKS_AS_APPROVALS on) has created one.
export function makeSubtask(overrides: Overrides): Overrides {
  return {
    assignee: null,
    completed: false,
    resource_subtype: 'default_task',
    ...overrides
  }
}
