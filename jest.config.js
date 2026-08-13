const common = {
  clearMocks: true,
  moduleFileExtensions: ['js', 'ts'],
  extensionsToTreatAsEsm: ['.ts'],
  resolver: 'ts-jest-resolver',
  transform: {
    '^.+\\.ts$': ['ts-jest', {useESM: true}]
  },
  setupFiles: ['<rootDir>/test/jest.polyfills.js'],
  verbose: true
}

export default {
  projects: [
    {
      ...common,
      displayName: 'unit',
      testMatch: ['<rootDir>/test/*.test.ts']
    },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.test.ts']
    }
  ]
}
