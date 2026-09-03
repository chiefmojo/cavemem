import { defaultSettings } from '@cavemem/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRemote, requireLocal } from '../src/util/mode.js';

const remote = {
  ...defaultSettings,
  remote: { url: 'http://neuromancer:37777', token: 't', timeoutMs: 1500 },
};

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('mode', () => {
  it('isRemote follows remote.url', () => {
    expect(isRemote(defaultSettings)).toBe(false);
    expect(isRemote(remote)).toBe(true);
  });

  it('requireLocal passes silently in local mode', () => {
    expect(requireLocal(defaultSettings, 'reindex')).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('requireLocal refuses in remote mode with exit code 1 and a pointer to the server', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(requireLocal(remote, 'reindex')).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(String(err.mock.calls[0]?.[0])).toContain('remote mode');
    expect(String(err.mock.calls[0]?.[0])).toContain('http://neuromancer:37777');
  });
});
