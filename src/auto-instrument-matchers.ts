import path from 'node:path'
import type { AutoInstrumentPath } from './types.js'

export interface Matcher {
  base: string
  dir: string
  prefix: string
}

/**
 * Build matchers from instrument path config entries.
 */
export function buildMatchers(
  instrumentPaths: AutoInstrumentPath[],
): Matcher[] {
  const matchers: Matcher[] = []
  for (const entry of instrumentPaths) {
    for (const dir of entry.dirs) {
      matchers.push({
        base: entry.base,
        dir,
        prefix: path.join(entry.base, dir) + path.sep,
      })
    }
  }
  return matchers
}

/**
 * Check if a resolved path matches any matcher, returning the relative
 * path (without extension) if matched, or null otherwise.
 */
export function matchPath(
  resolvedPath: string,
  matchers: Matcher[],
): string | null {
  for (const matcher of matchers) {
    if (resolvedPath.startsWith(matcher.prefix)) {
      return resolvedPath.slice(matcher.base.length + 1).replace(/\.[^.]+$/, '')
    }
  }
  return null
}
