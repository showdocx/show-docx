/**
 * Builds a glob pattern combining standard exclusions (node_modules, .git, .venv, vendor)
 * with workspace settings from files.exclude and search.exclude.
 */
export function buildExcludePattern(
  filesExclude?: Record<string, boolean>,
  searchExclude?: Record<string, boolean>,
): string {
  const patterns = new Set<string>([
    '**/node_modules/**',
    '**/.git/**',
    '**/.venv/**',
    '**/vendor/**',
  ]);

  for (const [pattern, enabled] of Object.entries({ ...(filesExclude ?? {}), ...(searchExclude ?? {}) })) {
    if (enabled && typeof pattern === 'string' && pattern.trim() !== '') {
      patterns.add(pattern);
    }
  }

  return '{' + Array.from(patterns).join(',') + '}';
}
