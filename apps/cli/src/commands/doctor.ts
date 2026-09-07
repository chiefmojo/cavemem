import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, resolveDataDir, settingsPath } from '@cavemem/config';
import { spoolDepth, spoolPath } from '@cavemem/hooks';
import { checkWindowsSh, codexMcpMode } from '@cavemem/installers';
import { Storage } from '@cavemem/storage';
import type { Command } from 'commander';
import kleur from 'kleur';
import { checkedRemoteTarget, probeRemote } from '../util/remote.js';
import { formatSummaryCoverage } from '../util/summary-coverage.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Run health checks')
    .action(async () => {
      const path = settingsPath();
      process.stdout.write(
        `settings: ${path} ${existsSync(path) ? kleur.green('ok') : kleur.red('missing')}\n`,
      );
      const settings = loadSettings();
      const dir = resolveDataDir(settings.dataDir);
      process.stdout.write(`dataDir:  ${dir}\n`);
      const target = checkedRemoteTarget(settings);
      if (target) {
        process.stdout.write(`mode:     remote ${target.url}\n`);
        process.stdout.write(
          `token:    ${target.token ? kleur.green('present') : kleur.red('missing')}\n`,
        );
        if (!target.token) process.exitCode = 1;
        const probe = await probeRemote(target);
        process.stdout.write(
          `server:   ${probe.healthz ? kleur.green('ok') : kleur.red('fail')} ${probe.error ?? ''}\n`,
        );
        process.stdout.write(`auth:     ${probe.auth ? kleur.green('ok') : kleur.red('fail')}\n`);
        if (!probe.healthz || !probe.auth) process.exitCode = 1;
        if (settings.ides.codex) {
          const mode = codexMcpMode(homedir());
          if (mode !== 'remote') {
            process.stdout.write(
              `codex:    ${kleur.yellow(
                mode === 'absent'
                  ? 'no `mcp_servers.cavemem` entry in ~/.codex/config.toml — run `cavemem install --ide codex`'
                  : '`mcp_servers.cavemem` is wired as local stdio — run `cavemem install --ide codex` to switch to remote',
              )}\n`,
            );
            process.exitCode = 1;
          }
        }
        const pid = join(dir, 'worker.pid');
        if (existsSync(pid)) {
          process.stdout.write(
            `worker:   ${kleur.yellow(`local pidfile present — run \`cavemem config unset remote.url\` (currently set in ${path}), run \`cavemem stop\`, then restore remote.url`)}\n`,
          );
        }
        process.stdout.write(`spool:    ${spoolDepth(spoolPath(settings))} queued\n`);
        return;
      }
      const dbPath = join(dir, 'data.db');
      try {
        const s = new Storage(dbPath);
        const sessions = s.listSessions(1).length;
        const coverage = s.summaryCoverage();
        s.close();
        process.stdout.write(`db:       ${dbPath} ${kleur.green('ok')} (${sessions} sessions)\n`);
        if (coverage.length > 0) {
          // IDEs with sessions but zero turn summaries are losing turn_summary.
          process.stdout.write(`summaries: ${formatSummaryCoverage(coverage)}\n`);
        }
      } catch (err) {
        process.stdout.write(`db:       ${dbPath} ${kleur.red('fail')} ${String(err)}\n`);
        process.exitCode = 1;
      }
      process.stdout.write(`port:     ${settings.workerPort}\n`);
      process.stdout.write(`comp:     intensity=${settings.compression.intensity}\n`);
      process.stdout.write(
        `embed:    ${settings.embedding.provider} / ${settings.embedding.model}\n`,
      );
      const enabled = Object.entries(settings.ides)
        .filter(([, v]) => v)
        .map(([k]) => k);
      process.stdout.write(
        `ides:     ${enabled.length ? enabled.join(', ') : kleur.dim('none')}\n`,
      );

      // win32 only — checkWindowsSh() returns null (no-op) on every other platform.
      const shWarning = checkWindowsSh();
      if (shWarning) {
        process.stdout.write(`sh:       ${kleur.red('not found on PATH')}\n`);
        process.stdout.write(`\n${kleur.yellow(shWarning)}\n`);
        process.exitCode = 1;
      }
    });
}
