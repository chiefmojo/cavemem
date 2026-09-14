import { constants, accessSync, realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** Keep a PATH symlink stable across runtime upgrades, without switching Node versions. */
export function resolveNodePath(
  options: {
    execPath?: string;
    path?: string;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const normalize = (value: string) => (platform === 'win32' ? value.toLowerCase() : value);
  try {
    const running = normalize(realpathSync(execPath));
    for (const entry of (options.path ?? process.env.PATH ?? '').split(paths.delimiter)) {
      const dir = platform === 'win32' ? entry.replace(/^"(.*)"$/, '$1') : entry;
      if (!paths.isAbsolute(dir)) continue;
      // A lone Windows root (\tools or /tools) depends on the working drive.
      if (platform === 'win32' && paths.parse(dir).root.length <= 1) continue;
      const candidate = paths.join(dir, platform === 'win32' ? 'node.exe' : 'node');
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
        if (normalize(realpathSync(candidate)) === running) return candidate;
      } catch {
        // Missing entries and stale symlinks must not hide a later matching Node.
      }
    }
  } catch {
    // The running interpreter remains the fallback even if its file was removed.
  }
  return execPath;
}

/**
 * Absolute path to the cavemem CLI binary. The installer writes this into
 * IDE config files, so it must resolve correctly in both dev and installed modes.
 */
export function resolveCliPath(): string {
  const argv1 = process.argv[1];
  if (!argv1) return 'cavemem';
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
}
