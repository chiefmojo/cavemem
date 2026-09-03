import { describe, expect, it } from 'vitest';
import { SettingsSchema, defaultSettings } from '../src/index.js';

describe('SettingsSchema', () => {
  it('parses empty object into defaults', () => {
    const parsed = SettingsSchema.parse({});
    expect(parsed.workerPort).toBe(37777);
    expect(parsed.compression.intensity).toBe('full');
  });

  it('rejects invalid intensity', () => {
    expect(() => SettingsSchema.parse({ compression: { intensity: 'xxx' } })).toThrow();
  });

  it('defaults match exported defaultSettings', () => {
    expect(defaultSettings.workerPort).toBe(37777);
    expect(defaultSettings.embedding.provider).toBe('local');
  });

  it('idleShutdownMs defaults to 600000', () => {
    expect(defaultSettings.embedding.idleShutdownMs).toBe(600_000);
  });

  it('idleShutdownMs: 0 disables idle shutdown and is preserved as 0', () => {
    const parsed = SettingsSchema.parse({ embedding: { idleShutdownMs: 0 } });
    expect(parsed.embedding.idleShutdownMs).toBe(0);
  });

  it('clamps a negative idleShutdownMs to 0', () => {
    const parsed = SettingsSchema.parse({ embedding: { idleShutdownMs: -5000 } });
    expect(parsed.embedding.idleShutdownMs).toBe(0);
  });

  it('remote block defaults to no url, no token, 1500 ms timeout', () => {
    expect(defaultSettings.remote.url).toBeUndefined();
    expect(defaultSettings.remote.token).toBeUndefined();
    expect(defaultSettings.remote.timeoutMs).toBe(1500);
  });

  it('remote.url must be an http(s) URL', () => {
    expect(() => SettingsSchema.parse({ remote: { url: 'neuromancer:37777' } })).toThrow();
    const ok = SettingsSchema.parse({ remote: { url: 'http://neuromancer:37777' } });
    expect(ok.remote.url).toBe('http://neuromancer:37777');
  });

  it('workerHost defaults to loopback and workerAllowedHosts to empty', () => {
    expect(defaultSettings.workerHost).toBe('127.0.0.1');
    expect(defaultSettings.workerAllowedHosts).toEqual([]);
  });

  it('workerAllowedHosts entries must be host:port', () => {
    expect(() => SettingsSchema.parse({ workerAllowedHosts: ['neuromancer'] })).toThrow();
    const ok = SettingsSchema.parse({ workerAllowedHosts: ['neuromancer:37777', '10.0.0.5:37777'] });
    expect(ok.workerAllowedHosts).toHaveLength(2);
  });
});
