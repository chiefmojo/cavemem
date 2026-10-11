import { describe, expect, it } from 'vitest';
import * as bridgeEntry from '../src/opencode-bridge.js';

describe('OpenCode bridge plugin export surface', () => {
  it('exposes only the default plugin definition from the source entry', () => {
    expect(Object.keys(bridgeEntry)).toEqual(['default']);
  });

  it('satisfies both the OpenCode V2 definition and the V1 object entrypoint', () => {
    const plugin = bridgeEntry.default;
    // V2 validates `{ id, setup }` (or `effect`); V1 >= 1.18.29 loads `server`.
    expect(plugin.id).toBe('cavemem');
    expect(typeof plugin.setup).toBe('function');
    expect(typeof plugin.server).toBe('function');
  });
});
