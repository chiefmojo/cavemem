import { describe, expect, it } from 'vitest';
import * as bridgeEntry from '../src/opencode-bridge.js';

describe('OpenCode bridge plugin export surface', () => {
  it('exposes only the default plugin factory from the source entry', () => {
    expect(Object.keys(bridgeEntry)).toEqual(['default']);
  });
});
