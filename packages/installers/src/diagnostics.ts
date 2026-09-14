import { constants, accessSync, readFileSync, statSync } from 'node:fs';
import { dirname, posix, win32 } from 'node:path';
import { parseCavememHook } from './fs-utils.js';
import type { InstallContext, InstallerDiagnostic } from './types.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function mcpNode(config: unknown, key = 'mcpServers'): unknown {
  const entry = record(record(record(config)[key]).cavemem);
  // The persisted transport is authoritative, even if current settings differ.
  if (typeof entry.url === 'string' || entry.type === 'remote' || entry.type === 'http')
    return undefined;
  return Array.isArray(entry.command) ? entry.command[0] : entry.command;
}

/** Inspect only hook registrations, never arbitrary user config or executable output. */
export function hookNodes(
  config: unknown,
  ctx: InstallContext,
  ide: string,
  wrapperDir?: string,
): string[] {
  const nodes: string[] = [];
  const platform = ctx.platform ?? process.platform;
  const addCommand = (value: unknown) => {
    const invocation = parseCavememHook(value, ide);
    if (invocation) nodes.push(invocation.nodeBin);
  };
  for (const groups of Object.values(record(record(config).hooks))) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const nested = record(group).hooks;
      for (const value of Array.isArray(nested) ? nested : [group]) {
        const hook = record(value);
        if (hook.type !== 'command') continue;
        const command =
          platform === 'win32' && typeof hook.commandWindows === 'string'
            ? hook.commandWindows
            : hook.command;
        if (!wrapperDir) addCommand(command);
        else if (typeof command === 'string' && dirname(command) === wrapperDir) {
          try {
            for (const line of readFileSync(command, 'utf8').split(/\r?\n/)) addCommand(line);
          } catch {
            // A missing wrapper has no persisted interpreter to inspect.
          }
        }
      }
    }
  }
  return nodes;
}

export function diagnoseNodes(
  ide: string,
  ctx: InstallContext,
  nodes: unknown[],
): InstallerDiagnostic[] {
  const platform = ctx.platform ?? process.platform;
  const paths = platform === 'win32' ? win32 : posix;
  const codes = new Set<InstallerDiagnostic['code']>();
  for (const node of nodes) {
    if (
      typeof node !== 'string' ||
      !paths.isAbsolute(node) ||
      !/^node(?:\.exe)?$/i.test(paths.basename(node))
    )
      continue;
    try {
      if (!statSync(node).isFile()) throw new Error('not a file');
      accessSync(node, platform === 'win32' ? constants.F_OK : constants.X_OK);
      if (/(?:^|\/)Cellar\/node(?:@[^/]+)?\/[^/]+\/(?:.*\/)?node$/.test(node))
        codes.add('node-fragile');
    } catch {
      codes.add('node-missing');
    }
  }
  return [...codes].map((code) => ({
    ide,
    code,
    message:
      code === 'node-missing'
        ? 'Persisted Node interpreter is missing or unusable'
        : 'Persisted Node interpreter is pinned to a Homebrew Cellar version',
    remedy: `cavemem install --ide ${ide}`,
  }));
}
