import { describe, expect, it } from 'vitest';
import { fixNewestEntry } from '../changelog-spacing.mjs';

// Shapes copied from `changeset version` (@changesets/cli 2.31.0, `"prettier": false`).
const RAW_NEW_ENTRY = [
  '# cavemem',
  '',
  '## 0.5.0',
  '### Minor Changes',
  '',
  '- Probe minor entry.',
  '  ',
  '  Second paragraph line.',
  '',
  '### Patch Changes',
  '',
  '- Probe patch entry.',
  '',
  '## 0.4.5',
  '',
  '### Patch Changes',
  '',
  '- 8895730: Rebuild before publishing.',
  '',
].join('\n');

describe('fixNewestEntry', () => {
  it('adds the blank line after the new version heading', () => {
    const fixed = fixNewestEntry(RAW_NEW_ENTRY);
    expect(fixed).toContain('## 0.5.0\n\n### Minor Changes');
  });

  it('empties whitespace-only lines inside the new entry', () => {
    const fixed = fixNewestEntry(RAW_NEW_ENTRY);
    expect(fixed).toContain('- Probe minor entry.\n\n  Second paragraph line.');
  });

  it('leaves older entries byte-for-byte unchanged', () => {
    const old = '## 0.4.5\n### Patch Changes\n  \n- old\n';
    const input = `# cavemem\n\n## 0.5.0\n### Patch Changes\n\n- new\n\n${old}`;
    expect(fixNewestEntry(input).endsWith(old)).toBe(true);
  });

  it('is a no-op on an already formatted changelog', () => {
    const formatted = fixNewestEntry(RAW_NEW_ENTRY);
    expect(fixNewestEntry(formatted)).toBe(formatted);
  });

  it('is a no-op on a changelog with no version entries', () => {
    expect(fixNewestEntry('# cavemem\n')).toBe('# cavemem\n');
  });
});
