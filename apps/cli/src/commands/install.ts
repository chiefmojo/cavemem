import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  defaultSettings,
  loadSettings,
  resolveDataDir,
  saveSettings,
  settingsPath,
} from '@cavemem/config';
import { type IdeName, checkWindowsSh, getInstaller, installers } from '@cavemem/installers';
import type { Command } from 'commander';
import kleur from 'kleur';
import { checkedRemoteTarget } from '../util/remote.js';
import { resolveCliPath } from '../util/resolve.js';

// Hooks run through Claude Code's own `sh -c` wrapper on Windows (#56).
// Codex hooks aren't available on Windows at all, and the other installers
// have no hooks (MCP-only) or spawn node directly (opencode), so claude-code
// is the only IDE that needs this preflight today.
const SH_DEPENDENT_IDES = new Set<IdeName>(['claude-code']);

export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Register hooks + MCP server for an IDE')
    .option('--ide <name>', 'IDE to target', 'claude-code')
    .action(async (opts: { ide: string }) => {
      const name = opts.ide as IdeName;
      if (!installers[name]) {
        throw new Error(
          `Unknown --ide ${opts.ide}. Choices: ${Object.keys(installers).join(', ')}`,
        );
      }
      const path = settingsPath();
      if (!existsSync(path)) {
        saveSettings(defaultSettings);
        process.stdout.write(`${kleur.dim('wrote')} ${path}\n`);
      }
      const settings = loadSettings();
      const target = checkedRemoteTarget(settings);
      if (target && !target.token) {
        process.stderr.write(
          `${kleur.red('remote.url is set but remote.token is empty')} — copy the server's worker-token into settings first\n`,
        );
        process.exitCode = 1;
        return;
      }
      const ctx = {
        ideConfigDir: homedir(),
        cliPath: resolveCliPath(),
        nodeBin: process.execPath,
        dataDir: resolveDataDir(settings.dataDir),
        ...(target?.token ? { remote: { url: target.url, token: target.token } } : {}),
      };
      const installer = getInstaller(name);
      const msgs = await installer.install(ctx);
      for (const m of msgs) process.stdout.write(`${kleur.green('✓')} ${m}\n`);
      settings.ides[name] = true;
      saveSettings(settings);

      // Non-fatal — install proceeds either way. The user may fix PATH after.
      if (SH_DEPENDENT_IDES.has(name)) {
        const shWarning = checkWindowsSh();
        if (shWarning) {
          process.stdout.write(
            `\n${kleur.red(kleur.bold('warning:'))} ${kleur.yellow(shWarning)}\n`,
          );
        }
      }

      const model = settings.embedding.model;
      const provider = settings.embedding.provider;

      process.stdout.write(`\n${kleur.bold('cavemem is wired into')} ${kleur.cyan(name)}\n`);
      process.stdout.write(
        `${kleur.dim(
          ctx.remote
            ? `remote mode — hooks and MCP talk to ${ctx.remote.url}`
            : 'memory writes happen in hooks — no daemon required on the hot path.',
        )}\n\n`,
      );
      process.stdout.write(`${kleur.bold('what to try next:')}\n`);
      process.stdout.write(
        `  ${kleur.cyan('cavemem status')}        show wiring + embedding backfill\n`,
      );
      process.stdout.write(
        ctx.remote
          ? // Viewer HTML now requires the cookie handshake (server.ts
            // viewerAuth) — the bare URL 401s. Not printing `?token=` here:
            // 6b95858 established that install output must never carry a
            // remote token, so the URL is bare and the token comes from
            // wherever the user already sourced it (settings.json / doctor).
            `  ${kleur.cyan(ctx.remote.url)}        open the remote memory viewer (append ?token=<remote.token>)\n`
          : `  ${kleur.cyan('cavemem viewer')}        open the memory viewer\n`,
      );
      process.stdout.write(
        `  ${kleur.cyan('cavemem search "…"')}    query your memory from the terminal\n`,
      );
      process.stdout.write(`  ${kleur.cyan('cavemem config show')}   see settings + docs\n\n`);

      if (provider === 'local') {
        process.stdout.write(
          `${kleur.dim(
            `embeddings: local ${model} — weights (~25 MB) download to ${ctx.dataDir}/models on first use.`,
          )}\n`,
        );
      } else if (provider === 'none') {
        process.stdout.write(
          `${kleur.yellow('embeddings: disabled')} (provider=none). enable with \`cavemem config set embedding.provider local\`.\n`,
        );
      } else {
        process.stdout.write(
          `${kleur.dim(`embeddings: ${provider} / ${model} — configure endpoint/apiKey via \`cavemem config\`.`)}\n`,
        );
      }
    });
}
