// ESM-only packages (resolved via test/jest.resolver.js) that ts-jest must
// compile to CommonJS, since Jest runs in CommonJS mode.
const ESM_ONLY_PACKAGES = [
  '@actions/core',
  '@actions/exec',
  '@actions/io',
  '@actions/http-client'
]

const common = {
  clearMocks: true,
  moduleFileExtensions: ['js', 'ts'],
  transform: {
    '^.+\\.[jt]s$': [
      'ts-jest',
      {
        tsconfig: {
          allowJs: true,
          module: 'commonjs',
          moduleResolution: 'node10'
        }
      }
    ]
  },
  transformIgnorePatterns: [
    `/node_modules/(?!(${ESM_ONLY_PACKAGES.join('|')})/)`
  ],
  resolver: '<rootDir>/test/jest.resolver.js',
  setupFiles: ['<rootDir>/test/jest.polyfills.js'],
  verbose: true
}

module.exports = {
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
