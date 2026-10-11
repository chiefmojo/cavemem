import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function writeFakeOpenCode(home: string): string {
  const bin = join(home, 'fake-opencode-bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'opencode.mjs');
  writeFileSync(
    script,
    [
      "import { readFileSync } from 'node:fs';",
      "if (process.argv.slice(2).join(' ') === '--version') { if (process.env.FAKE_OPENCODE_VERSION === 'fail') process.exit(7); process.stdout.write((process.env.FAKE_OPENCODE_VERSION ?? 'opencode v2.0.26') + '\\n'); process.exit(0); }",
      "const version = process.env.FAKE_OPENCODE_VERSION ?? 'opencode v2.0.26';",
      "const v2 = /(\\d+)\\./.exec(version)?.[1] === '2';",
      "if (process.argv.slice(2).join(' ') !== (v2 ? 'debug config' : 'debug config --pure')) { process.stderr.write('wrong arguments'); process.exit(8); }",
      'if (process.env.FAKE_OPENCODE_FAILURE) { process.stderr.write(process.env.FAKE_OPENCODE_FAILURE); process.exit(9); }',
      "const root = process.env.XDG_CONFIG_HOME ?? process.env.HOME + '/.config';",
      "const raw = () => readFileSync(root + '/opencode/opencode.json', 'utf8');",
      // OpenCode 2 lists sources with each `info` normalized: mcp.servers,
      // `disabled` for `enabled`, header values masked.
      'function toV2(config) {',
      '  const servers = {};',
      '  for (const [name, entry] of Object.entries(config.mcp ?? {})) {',
      '    const { enabled, headers, ...rest } = entry;',
      "    servers[name] = { ...rest, ...(headers ? { headers: Object.fromEntries(Object.keys(headers).map((k) => [k, '***'])) } : {}), ...(enabled === undefined ? {} : { disabled: !enabled }) };",
      '  }',
      "  return [{ type: 'document', path: root + '/opencode/opencode.json', info: { mcp: { servers } } }];",
      '}',
      'process.stdout.write(process.env.FAKE_OPENCODE_OUTPUT ?? (v2 ? JSON.stringify(toV2(JSON.parse(raw()))) : raw()));',
    ].join('\n'),
  );
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'opencode.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const executable = join(bin, 'opencode');
    writeFileSync(
      executable,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`,
    );
    chmodSync(executable, 0o755);
  }
  return bin;
}
