// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Overrides = Record<string, any>

let gidCounter = 1000
export function nextGid(): string {
  gidCounter += 1
  return String(gidCounter)
}

export function makeTask(overrides: Overrides = {}): Overrides {
  return {
    gid: nextGid(),
    name: 'A task',
    permalink_url: 'https://app.asana.com/0/2000/9999',
    memberships: [],
    ...overrides
  }
}

export function makeUser(overrides: Overrides = {}): Overrides {
  return {
    gid: nextGid(),
    email: 'user@example.com',
    name: 'A User',
    ...overrides
  }
}

export function makeSubtask(overrides: Overrides = {}): Overrides {
  return {
    gid: nextGid(),
    assignee: null,
    completed: false,
    ...overrides
  }
}
