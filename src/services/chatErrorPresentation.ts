import { APIError, IncompleteStreamError, StreamProtocolError } from './api';

/** Present recovery based on what was actually retained by the turn handler. */
export const chatErrorText = (error: unknown, partialSaved = false): string => {
  const reference = error instanceof IncompleteStreamError && error.diagnostics
    ? ` (ref: ${error.diagnostics.turnId})`
    : '';
  if (partialSaved) {
    const cause = error instanceof APIError && (error.status === 401 || error.status === 403)
      ? 'Your session expired; reload the page or sign in before trying again.'
      : error instanceof APIError && error.status === 429
        ? 'The service is rate-limiting requests; wait before trying again.'
        : error instanceof APIError && error.code === 'network_error'
          ? 'Check your network connection before trying again.'
          : 'The response was interrupted before completion.';
    return `${cause} The partial answer is shown above; use Regenerate when ready.${reference}`;
  }
  if (error instanceof IncompleteStreamError) {
    if (error.code === 'completed_empty') {
      return `The assistant finished without producing an answer. Please retry.${reference}`;
    }
    return `The response was interrupted before completion. You can retry it.${reference}`;
  }
  if (error instanceof StreamProtocolError) return 'The server returned an invalid streaming response. Please retry.';
  if (error instanceof APIError) {
    if (error.code === 'identity_required' || error.code === 'identity_changed' || error.status === 428) {
      return 'Your session is being rechecked. Retry after verification completes.';
    }
    if (error.code === 'conversation_busy') {
      const wait = error.retryAfterMs === undefined ? '' : ` Try again in ${Math.max(1, Math.ceil(error.retryAfterMs / 1_000))} seconds.`;
      return `This conversation is still finishing another operation.${wait}`;
    }
    if (error.status === 429 || error.status === 400 || error.status === 413) {
      return error.message.length > 200 ? `${error.message.slice(0, 200)}…` : error.message;
    }
    if (error.status === 401 || error.status === 403) {
      return 'Your session expired. Reload the page, or sign in, and try again.';
    }
    if (error.code === 'timeout') return 'The AI service took too long to respond. Please retry.';
    if (error.code === 'network_error') return 'Network error. Check your connection and retry.';
    if (error.code === 'revision_conflict') return 'The support case changed. Reload its saved facts, then retry your message.';
    if (error.code === 'support_case_required' || error.code === 'support_case_switch_requires_new_chat') return 'Start a new chat or choose another support case to continue troubleshooting.';
    if (error.retryable) return 'The AI service is temporarily unavailable. Please retry.';
  }
  return 'Failed to send the message. Please retry.';
};
