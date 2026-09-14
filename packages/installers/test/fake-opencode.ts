import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeFakeOpenCode(home: string): string {
  const bin = join(home, 'fake-opencode-bin');
  mkdirSync(bin, { recursive: true });
  const script = join(bin, 'opencode.js');
  writeFileSync(
    script,
    [
      "import { readFileSync } from 'node:fs';",
      "if (process.argv.slice(2).join(' ') !== 'debug config --pure') { process.stderr.write('wrong arguments'); process.exit(8); }",
      'if (process.env.FAKE_OPENCODE_FAILURE) { process.stderr.write(process.env.FAKE_OPENCODE_FAILURE); process.exit(9); }',
      "const root = process.env.XDG_CONFIG_HOME ?? process.env.HOME + '/.config';",
      "process.stdout.write(process.env.FAKE_OPENCODE_OUTPUT ?? readFileSync(root + '/opencode/opencode.json', 'utf8'));",
    ].join('\n'),
  );
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'opencode.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const executable = join(bin, 'opencode');
    writeFileSync(executable, `#!${process.execPath}\nimport './opencode.js';\n`);
    chmodSync(executable, 0o755);
  }
  return bin;
}
