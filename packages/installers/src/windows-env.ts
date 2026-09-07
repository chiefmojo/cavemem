import { spawnSync } from 'node:child_process';

// Windows user-environment persistence for the Codex remote bearer token
// (WP #231 issue #4). Codex reads `bearer_token_env_var` from its own process
// environment at startup (`resolve_bearer_token` => `env::var`), so on native
// Windows the token must live in the *user* environment (registry
// `HKCU\Environment`), not merely the current shell's process env — a prior
// `setx` leaves an already-open terminal's `process.env` stale, so checking
// only `process.env` gives false "not set" results. `setx` writes the user env
// AND broadcasts `WM_SETTINGCHANGE`, so newly launched terminals / Codex
// sessions inherit the value without a reboot. `reg query` reads the persisted
// value back for drift comparison.

export interface WindowsUserEnvOptions {
  /** Defaults to `process.platform`. Injectable so non-Windows CI can exercise the win32 branch. */
  platform?: NodeJS.Platform;
  /** Defaults to `readUserEnvDefault`. Injectable so tests don't shell out. */
  readUserEnv?: (name: string) => string | null;
  /** Defaults to `writeUserEnvDefault`. Injectable so tests don't shell out. */
  writeUserEnv?: (name: string, value: string) => boolean;
}

export interface WindowsUserEnvSyncResult {
  /** True when the value is now the requested one in the user env (unchanged before, or written successfully). */
  synced: boolean;
  /** True when we actually wrote the value (it was missing or differed). */
  changed: boolean;
  /** The value previously in the user env, or null when unset. */
  previous: string | null;
}

/** Default reader: `reg query "HKCU\Environment" /v <name>`, parsed for the persisted value. */
export function readUserEnvDefault(name: string): string | null {
  const result = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) return null;
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(new RegExp(`${name}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+?)\\s*$`));
    if (match) return match[1] ?? null;
  }
  return null;
}

/** Default writer: `setx <name> <value>` — writes the user env and broadcasts the change. */
export function writeUserEnvDefault(name: string, value: string): boolean {
  const result = spawnSync('setx', [name, value], { windowsHide: true });
  return result.status === 0;
}

/**
 * Ensures `value` is persisted in the Windows user environment under `name`,
 * writing it when missing or drifted. No-op on non-Windows platforms (those
 * use a shell-profile `export`, handled separately by the installer hint).
 */
export function syncWindowsUserEnvVar(
  name: string,
  value: string,
  options: WindowsUserEnvOptions = {},
): WindowsUserEnvSyncResult {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { synced: false, changed: false, previous: null };
  const readUserEnv = options.readUserEnv ?? readUserEnvDefault;
  const writeUserEnv = options.writeUserEnv ?? writeUserEnvDefault;
  const previous = readUserEnv(name);
  if (previous === value) return { synced: true, changed: false, previous };
  const wrote = writeUserEnv(name, value);
  return { synced: wrote, changed: wrote, previous };
}
