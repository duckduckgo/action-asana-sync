// @actions/core 3 and its @actions/* dependencies are ESM-only and only
// export an `import` condition. Jest runs in CommonJS mode, so map those
// packages to their entry files and let ts-jest compile them to CommonJS
// along with our own TypeScript.
const ESM_ONLY_PACKAGES = ['@actions/core', '@actions/exec', '@actions/io', '@actions/http-client']
const escape = s => s.replace(/[/.]/g, '\\$&')

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
  transformIgnorePatterns: [`/node_modules/(?!(${ESM_ONLY_PACKAGES.map(escape).join('|')})/)`],
  moduleNameMapper: {
    '^@actions/core$': '<rootDir>/node_modules/@actions/core/lib/core.js',
    '^@actions/exec$': '<rootDir>/node_modules/@actions/exec/lib/exec.js',
    '^@actions/io$': '<rootDir>/node_modules/@actions/io/lib/io.js',
    '^@actions/io/lib/(.*)$': '<rootDir>/node_modules/@actions/io/lib/$1.js',
    '^@actions/http-client$': '<rootDir>/node_modules/@actions/http-client/lib/index.js',
    '^@actions/http-client/lib/(.*)$': '<rootDir>/node_modules/@actions/http-client/lib/$1.js'
  },
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
