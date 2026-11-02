import { describe, expect, it } from 'vitest';
import { APIError, IncompleteStreamError, StreamProtocolError } from '../services/api';
import { chatErrorText } from '../services/chatErrorPresentation';

describe('chat error recovery guidance', () => {
  it('describes an answer retained after a partial stream without suggesting an automatic replay', () => {
    const error = new IncompleteStreamError('truncated', 'partial answer');
    expect(chatErrorText(error, true)).toMatch(/partial answer is shown above; use Regenerate/);
  });

  it('does not claim a partial answer was saved when a branch operation restored its original messages', () => {
    const error = new IncompleteStreamError('truncated', 'partial answer');
    expect(chatErrorText(error)).toMatch(/interrupted before completion/);
    expect(chatErrorText(error)).not.toMatch(/partial answer is shown/);
  });

  it('distinguishes session, contention and malformed stream errors', () => {
    expect(chatErrorText(new APIError('secret', { status: 401 }))).toMatch(/session expired/i);
    expect(chatErrorText(new APIError('busy', { code: 'conversation_busy', retryAfterMs: 1500 }))).toMatch(/2 seconds/);
    expect(chatErrorText(new StreamProtocolError())).toMatch(/invalid streaming response/);
  });
});
