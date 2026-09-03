import type { Settings } from '@cavemem/config';
import kleur from 'kleur';

export function isRemote(settings: Settings): boolean {
  return Boolean(settings.remote.url);
}

/**
 * Local-only commands (worker, reindex, export/import, viewer, stdio mcp)
 * have no meaning on a remote-mode client — there is no local store. Refuse
 * loudly rather than operate on an empty data.db.
 */
export function requireLocal(settings: Settings, command: string): boolean {
  if (!isRemote(settings)) return true;
  process.stderr.write(
    `${kleur.red('remote mode:')} run \`cavemem ${command}\` on the server (${settings.remote.url})\n`,
  );
  process.exitCode = 1;
  return false;
}
