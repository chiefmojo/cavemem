import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { readJson, shellQuote, writeJson } from './fs-utils.js';
import type { InstallContext, Installer } from './types.js';

/**
 * Reads the current Codex MCP wiring for cavemem from
 * `<ideConfigDir>/.codex/config.toml`, so `doctor` can flag a stdio entry that
 * was left behind when remote mode became active (WP #231 issue #3).
 */
export function codexMcpMode(ideConfigDir: string): 'remote' | 'stdio' | 'absent' {
  const cfg = readToml(join(ideConfigDir, '.codex', 'config.toml'));
  const servers = cfg.mcp_servers as Record<string, Record<string, unknown>> | undefined;
  const cavemem = servers?.cavemem;
  if (!cavemem) return 'absent';
  return typeof cavemem.url === 'string' ? 'remote' : 'stdio';
}

/**
 * Warns when a Codex config indicates Codex runs under WSL (WP #231 issue #5).
 * A Windows-installed cavemem writes `node.exe` + CLI paths into
 * `%USERPROFILE%\.codex`, which WSL Codex never reads — it uses `~/.codex`
 * inside WSL and has no Windows binary on its PATH.
 *
 * Only `runCodexInWindowsSubsystemForLinux` is checked. The `[desktop]` table is
 * opaque passthrough to the codex-cli (it never reads either key), and both keys
 * are written by the closed-source desktop app — so this is a best-effort proxy.
 * `integratedTerminalShell` is deliberately NOT checked: `"wsl"` there only means
 * the desktop app's integrated terminal opens a WSL shell, a false positive on
 * native-Windows installs where Codex itself runs on Windows.
 */
export function codexWslWarning(cfg: Record<string, unknown>): string | null {
  const desktop = cfg.desktop as Record<string, unknown> | undefined;
  const runsInWsl = desktop?.runCodexInWindowsSubsystemForLinux === true;
  if (!runsInWsl) return null;
  return [
    'This Codex config indicates Codex runs under WSL',
    '(runCodexInWindowsSubsystemForLinux). This install writes Windows paths',
    '(node.exe + the cavemem CLI) into %USERPROFILE%\\.codex, which WSL Codex does',
    'not read — it uses ~/.codex inside WSL and has no Windows binary on its PATH.',
    '',
    'fix: run `cavemem install --ide codex` *inside* WSL (Linux node + $HOME/.codex)',
    'for WSL sessions, or reference the Windows binary via /mnt/c/... interop.',
  ].join('\n');
}

interface CodexHookCommand {
  type: 'command';
  command: string;
  commandWindows?: string;
  statusMessage?: string;
}

interface CodexHookGroup {
  hooks: CodexHookCommand[];
}

interface CodexHooksFile {
  hooks?: Record<string, CodexHookGroup[]>;
}

const HOOK_NAMES: Array<[string, string, string?]> = [
  ['SessionStart', 'session-start', 'Loading cavemem context'],
  ['UserPromptSubmit', 'user-prompt-submit'],
  ['PostToolUse', 'post-tool-use'],
  ['Stop', 'stop'],
];

function configFile(ctx: InstallContext): string {
  return join(ctx.ideConfigDir, '.codex', 'config.toml');
}

function hooksFile(ctx: InstallContext): string {
  return join(ctx.ideConfigDir, '.codex', 'hooks.json');
}

function legacyConfigFile(ctx: InstallContext): string {
  // Earlier versions of this installer wrote a JSON config that Codex never
  // read. Cleaned up on uninstall.
  return join(ctx.ideConfigDir, '.codex', 'config.json');
}

function isCavememHookGroup(group: CodexHookGroup, hookId: string): boolean {
  return group.hooks.some((h) => h.type === 'command' && h.command.includes(`hook run ${hookId}`));
}

// smol-toml round-trips most config.toml shapes, but it does not support
// inline tables for arbitrary user content. We accept that limitation: if a
// user has hand-written exotic TOML, parsing should still work; re-emission
// uses the canonical multi-line form.
function readToml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return parseToml(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeToml(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stringifyToml(data)}\n`, 'utf8');
}

export const codex: Installer = {
  id: 'codex',
  label: 'Codex CLI',
  capture: 'full',
  captureNotes: 'no SessionEnd event',
  async detect(ctx: InstallContext): Promise<boolean> {
    return existsSync(join(ctx.ideConfigDir, '.codex'));
  },
  async install(ctx: InstallContext): Promise<string[]> {
    const messages: string[] = [];
    const cfgPath = configFile(ctx);
    const hooksPath = hooksFile(ctx);

    // ---- config.toml: features.hooks + mcp_servers.cavemem ----
    // `features.hooks` is the canonical key; `codex_hooks` is a deprecated
    // alias that still works but emits a startup warning.
    const cfg = readToml(cfgPath);
    const wslWarning = codexWslWarning(cfg);

    const features = (cfg.features as Record<string, unknown> | undefined) ?? {};
    features.hooks = true;
    // Remove the deprecated alias so a re-install over a 0.4.0-era config
    // doesn't leave `codex_hooks` behind — Codex keeps warning while the key
    // is present, even alongside the canonical `hooks` key.
    delete features.codex_hooks;
    cfg.features = features;

    const mcpServers =
      (cfg.mcp_servers as Record<string, Record<string, unknown>> | undefined) ?? {};
    mcpServers.cavemem = ctx.remote
      ? {
          url: `${ctx.remote.url.replace(/\/+$/, '')}/mcp`,
          // Static bearer via request headers, matching Claude Code / OpenCode.
          // `bearer_token` is rejected at parse, and `bearer_token_env_var`
          // needs out-of-band env setup — the WP #231 issue #4 failure mode.
          http_headers: { Authorization: `Bearer ${ctx.remote.token}` },
        }
      : { command: ctx.nodeBin, args: [ctx.cliPath, 'mcp'] };
    cfg.mcp_servers = mcpServers;

    writeToml(cfgPath, cfg);
    messages.push(`wrote ${cfgPath}`);

    // ---- hooks.json: register cavemem entries; preserve user hooks ----
    // Codex executes each hook `command` through a shell (cmd /C on Windows,
    // sh -lc on Unix), so nodeBin + cliPath must be shell-quoted — Windows
    // npm paths can contain spaces and backslashes.
    const nodeBin = shellQuote(ctx.nodeBin);
    const cliPath = shellQuote(ctx.cliPath);
    const hooks = readJson<CodexHooksFile>(hooksPath, {});
    const hookMap: Record<string, CodexHookGroup[]> = { ...(hooks.hooks ?? {}) };
    const platform = ctx.platform ?? process.platform;

    for (const [eventName, hookId, statusMessage] of HOOK_NAMES) {
      const existing = hookMap[eventName] ?? [];
      const others = existing.filter((g) => !isCavememHookGroup(g, hookId));
      // Codex uses `command` with Unix semantics and `commandWindows` on
      // native Windows; the base command string would otherwise be run with
      // assumptions that break a Windows `node.exe` + `.js` path. Only emit
      // `commandWindows` on win32 — elsewhere it would carry a dead Unix path
      // (ignored by Codex anyway). The string is shellQuote'd to be safe under
      // both cmd.exe and sh, so it serves both fields.
      const command = `${nodeBin} ${cliPath} hook run ${hookId} --ide codex`;
      const commandHook: CodexHookCommand = { type: 'command', command };
      if (platform === 'win32') commandHook.commandWindows = command;
      const group: CodexHookGroup = {
        hooks: [{ ...commandHook, ...(statusMessage ? { statusMessage } : {}) }],
      };
      others.push(group);
      hookMap[eventName] = others;
    }

    writeJson(hooksPath, { ...hooks, hooks: hookMap });
    messages.push(`wrote ${hooksPath}`);
    if (wslWarning) messages.push(wslWarning);

    return messages;
  },
  async uninstall(ctx: InstallContext): Promise<string[]> {
    const messages: string[] = [];
    const cfgPath = configFile(ctx);
    const hooksPath = hooksFile(ctx);
    const legacy = legacyConfigFile(ctx);

    if (existsSync(cfgPath)) {
      const cfg = readToml(cfgPath);
      const mcpServers = cfg.mcp_servers as Record<string, unknown> | undefined;
      if (mcpServers && 'cavemem' in mcpServers) {
        delete mcpServers.cavemem;
        if (Object.keys(mcpServers).length === 0) delete cfg.mcp_servers;
      }
      // Remove our own deprecated `codex_hooks` alias if an earlier install
      // wrote it; leave the canonical `[features].hooks` flag alone — turning
      // it off would break other tools that rely on it. The hooks.json cleanup
      // below is enough to stop cavemem hooks from firing.
      const features = cfg.features as Record<string, unknown> | undefined;
      if (features && 'codex_hooks' in features) delete features.codex_hooks;
      writeToml(cfgPath, cfg);
      messages.push(`updated ${cfgPath}`);
    }

    if (existsSync(hooksPath)) {
      const hooks = readJson<CodexHooksFile>(hooksPath, {});
      if (hooks.hooks) {
        for (const [eventName, hookId] of HOOK_NAMES) {
          const arr = hooks.hooks[eventName];
          if (!arr) continue;
          const remaining = arr.filter((g) => !isCavememHookGroup(g, hookId));
          if (remaining.length === 0) delete hooks.hooks[eventName];
          else hooks.hooks[eventName] = remaining;
        }
      }
      writeJson(hooksPath, hooks);
      messages.push(`updated ${hooksPath}`);
    }

    if (existsSync(legacy)) {
      const cur = readJson<{ mcpServers?: Record<string, unknown> }>(legacy, {});
      if (cur.mcpServers) {
        delete cur.mcpServers.cavemem;
        if (Object.keys(cur.mcpServers).length === 0) delete cur.mcpServers;
      }
      writeJson(legacy, cur);
      messages.push(`updated ${legacy}`);
    }

    return messages;
  },
};
