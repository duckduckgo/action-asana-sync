// Some dependencies (@actions/core 3 and its @actions/* deps) are ESM-only and
// export nothing under the `require` condition Jest uses in CommonJS mode.
// Resolve normally first, so dual packages keep their CommonJS builds, and
// only fall back to the `import` condition when that fails.
module.exports = (path, options) => {
  try {
    return options.defaultResolver(path, options)
  } catch (error) {
    try {
      return options.defaultResolver(path, {
        ...options,
        conditions: [...(options.conditions ?? []), 'import']
      })
    } catch {
      throw error
    }
  }
}
