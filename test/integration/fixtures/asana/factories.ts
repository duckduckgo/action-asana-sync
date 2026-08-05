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

export function makeSubtask(overrides: Overrides): Overrides {
  return {
    assignee: null,
    completed: false,
    ...overrides
  }
}
