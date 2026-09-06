import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readJson, writeJson } from './fs-utils.js';
import type { InstallContext, Installer } from './types.js';

type OpenCodeMcpEntry =
  | { type: 'local'; command: string[]; enabled: boolean }
  | { type: 'remote'; url: string; headers?: Record<string, string>; enabled: boolean };

interface OpenCodeConfig {
  mcp?: Record<string, OpenCodeMcpEntry>;
  mcpServers?: Record<string, { command: string; args?: string[] }>;
  plugin?: string[];
}

function configRoot(ctx: InstallContext): string {
  // Per OpenCode docs, the user-global config dir is ~/.config/opencode/.
  // We honor XDG_CONFIG_HOME if set.
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, 'opencode') : join(ctx.ideConfigDir, '.config', 'opencode');
}

function configFile(ctx: InstallContext): string {
  return join(configRoot(ctx), 'opencode.json');
}

function pluginDir(ctx: InstallContext): string {
  return join(configRoot(ctx), 'plugins');
}

function pluginLink(ctx: InstallContext): string {
  return join(pluginDir(ctx), 'cavemem.js');
}

// Legacy locations from earlier versions of this installer. Cleaned up on
// uninstall so users don't end up with stale files.
function legacyConfigFile(ctx: InstallContext): string {
  return join(ctx.ideConfigDir, '.opencode', 'config.json');
}

/** Foreign bridge: a plugin in the OpenCode plugins dir that talks to cavemem but isn't our symlinked bridge. */
export function findForeignBridges(pluginsDir: string, bridgeSource: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(pluginsDir);
  } catch {
    return [];
  }
  // realpath(bridgeSource) once: pnpm/npm installs can put symlinks between
  // the plugins dir and the real bridge file, and a missing bridgeSource must
  // not fail the whole scan.
  let realSource: string | null = null;
  try {
    realSource = realpathSync(bridgeSource);
  } catch {
    realSource = null;
  }
  const hits: string[] = [];
  for (const name of entries) {
    if (name === 'cavemem.js' || !/\.(js|mjs|cjs)$/.test(name)) continue;
    const full = join(pluginsDir, name);
    try {
      if (lstatSync(full).isSymbolicLink()) {
        const resolved = realpathSync(full);
        // Our own bridge re-linked under a different name — same code, harmless.
        if (resolved === realSource) continue;
        // realSource can stay null (bridgeSource unreadable mid-upgrade); the
        // bundled bridge's real filename still identifies our symlink targets.
        if (basename(resolved) === 'opencodeBridge.js') continue;
      }
      if (readFileSync(full, 'utf8').toLowerCase().includes('cavemem')) hits.push(full);
    } catch {
      // Unreadable, binary, or a dangling symlink — treat as not-a-bridge.
    }
  }
  return hits;
}

export const openCode: Installer = {
  id: 'opencode',
  label: 'OpenCode',
  capture: 'full',
  captureNotes: 'via bundled bridge plugin, not hooks.json',
  async detect(ctx: InstallContext): Promise<boolean> {
    // Prefer the modern XDG path; fall back to the legacy dot-dir.
    return existsSync(configRoot(ctx)) || existsSync(join(ctx.ideConfigDir, '.opencode'));
  },
  async install(ctx: InstallContext): Promise<string[]> {
    const messages: string[] = [];

    // 1. Write MCP config to the correct OpenCode config file.
    const path = configFile(ctx);
    const current = readJson<OpenCodeConfig>(path, {});
    const entry: OpenCodeMcpEntry = ctx.remote
      ? {
          type: 'remote',
          url: `${ctx.remote.url.replace(/\/+$/, '')}/mcp`,
          headers: { Authorization: `Bearer ${ctx.remote.token}` },
          enabled: true,
        }
      : {
          type: 'local',
          command: [ctx.nodeBin, ctx.cliPath, 'mcp'],
          enabled: true,
        };
    const next: OpenCodeConfig = {
      ...current,
      mcp: { ...(current.mcp ?? {}), cavemem: entry },
    };
    // Migrate away from the old `mcpServers` key a prior installer version
    // wrote into this same file (OpenCode never read it — it expects `mcp`).
    // Without this, upgrading in place leaves a stale, orphaned entry behind.
    if (next.mcpServers?.cavemem) {
      delete next.mcpServers.cavemem;
      if (Object.keys(next.mcpServers).length === 0) delete next.mcpServers;
    }
    // Ensure the bundled bridge plugin is listed so OpenCode auto-loads it.
    // Plugins in plugins/ also auto-load, but listing in `plugin` makes intent
    // explicit and survives plugin-dir overrides.
    const pluginList = Array.from(new Set([...(next.plugin ?? []), 'file://./plugins/cavemem.js']));
    next.plugin = pluginList;
    writeJson(path, next);
    messages.push(`wrote ${path}`);

    // 2. Symlink the bridge plugin into the OpenCode plugins directory.
    const bridgeSource = join(dirname(ctx.cliPath), 'opencodeBridge.js');
    const pluginsDir = pluginDir(ctx);
    const link = pluginLink(ctx);
    mkdirSync(pluginsDir, { recursive: true });

    if (existsSync(link)) {
      // Remove stale symlink (points to an old cavemem install).
      unlinkSync(link);
    }
    symlinkSync(bridgeSource, link);
    messages.push(`symlinked bridge plugin ${link} -> ${bridgeSource}`);

    // OpenCode loads every file in plugins/, so a stale hand-written bridge
    // that also references cavemem runs alongside ours and misses turn_summary
    // — silently disabling turn summaries. Warn; never delete user files from
    // a non-interactive CLI.
    for (const p of findForeignBridges(pluginsDir, bridgeSource)) {
      messages.push(
        `warning: foreign bridge plugin ${p} also references cavemem — it may shadow ${link}; OpenCode loads it too and stale bridges miss turn_summary. Remove or replace it.`,
      );
    }

    // 3. Clean up legacy config if it still has a stale mcpServers entry.
    const legacyFile = legacyConfigFile(ctx);
    if (existsSync(legacyFile)) {
      try {
        const legacy = JSON.parse(readFileSync(legacyFile, 'utf8')) as {
          mcpServers?: Record<string, unknown>;
        };
        if (legacy.mcpServers?.cavemem) {
          delete legacy.mcpServers.cavemem;
          writeFileSync(legacyFile, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
          messages.push(`removed stale legacy MCP entry from ${legacyFile}`);
        }
      } catch {
        // Ignore parse errors in legacy config — not our file anymore.
      }
    }

    return messages;
  },
  async uninstall(ctx: InstallContext): Promise<string[]> {
    const messages: string[] = [];

    // 1. Remove MCP config and plugin entry from modern path.
    const cfgPath = configFile(ctx);
    const legacyFile = legacyConfigFile(ctx);

    for (const path of [cfgPath, legacyFile]) {
      if (!existsSync(path)) continue;
      const current = readJson<OpenCodeConfig>(path, {});
      if (current.mcp) {
        delete current.mcp.cavemem;
        if (Object.keys(current.mcp).length === 0) delete current.mcp;
      }
      if (current.mcpServers) {
        delete current.mcpServers.cavemem;
        if (Object.keys(current.mcpServers).length === 0) delete current.mcpServers;
      }
      if (current.plugin) {
        current.plugin = current.plugin.filter((p) => p !== 'file://./plugins/cavemem.js');
        if (current.plugin.length === 0) delete current.plugin;
      }
      writeJson(path, current);
      messages.push(`updated ${path}`);
    }

    // 2. Remove bridge plugin symlink.
    const link = pluginLink(ctx);
    if (existsSync(link)) {
      unlinkSync(link);
      messages.push(`removed plugin symlink ${link}`);
    }

    return messages;
  },
};
