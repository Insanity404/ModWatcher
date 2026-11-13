import { createRequire } from 'node:module';

// The release build (scripts/build-release.mjs) replaces this identifier with the version string.
declare const __MODWATCHER_VERSION__: string | undefined;

/** The release's own version, or package.json's (marked +source) when run from source. */
export const VERSION: string =
  typeof __MODWATCHER_VERSION__ === 'string' ? __MODWATCHER_VERSION__ : sourceVersion();

function sourceVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? `${pkg.version}+source` : 'unknown';
  } catch {
    return 'unknown';
  }
}
