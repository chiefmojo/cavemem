import { describe, expect, it } from 'vitest';
import { ideOutputPayload } from '../src/commands/hook.js';

describe('ideOutputPayload', () => {
  it('systemMessage carries the warning alongside additionalContext', () => {
    expect(
      ideOutputPayload('session-start', { ok: true, ms: 1, context: 'C', warning: 'W' }),
    ).toEqual({
      systemMessage: 'W',
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'C' },
    });
  });

  it('warning alone emits only systemMessage', () => {
    expect(ideOutputPayload('session-start', { ok: true, ms: 1, warning: 'W' })).toEqual({
      systemMessage: 'W',
    });
  });

  it('healthy output is unchanged', () => {
    expect(ideOutputPayload('session-start', { ok: true, ms: 1, context: 'C' })).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'C' },
    });
    expect(ideOutputPayload('session-start', { ok: true, ms: 1 })).toBeUndefined();
    expect(ideOutputPayload('session-start', { ok: true, ms: 1, context: '  ' })).toBeUndefined();
  });

  it('only session-start surfaces the warning', () => {
    expect(
      ideOutputPayload('user-prompt-submit', { ok: true, ms: 1, context: 'C', warning: 'W' }),
    ).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'C' },
    });
    expect(ideOutputPayload('stop', { ok: true, ms: 1, warning: 'W' })).toBeUndefined();
  });
});
