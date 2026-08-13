import * as esbuild from 'esbuild'
import esbuildPluginLicense from 'esbuild-plugin-license'
import {writeFileSync} from 'node:fs'

await esbuild.build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  legalComments: 'none',
  plugins: [
    esbuildPluginLicense({
      // options.banner || defaultOptions.banner falls back to the default
      // banner comment on any falsy value, so '' doesn't suppress it -- a
      // single space does, and is otherwise inert as bundle output.
      banner: ' ',
      thirdParty: {
        output: {
          file: 'dist/licenses.txt',
          template: dependencies =>
            dependencies
              .map(
                dep =>
                  `${dep.packageJson.name}\n${dep.packageJson.license}\n${dep.licenseText}`
              )
              .join('\n\n')
        }
      }
    })
  ]
})

// Node resolves a file's module type from the nearest package.json. This
// keeps dist/index.js unambiguously ESM even if it's ever consumed apart
// from the repo's own package.json (the pattern actions/setup-node's ESM
// migration uses).
writeFileSync('dist/package.json', JSON.stringify({type: 'module'}, null, 2) + '\n')
