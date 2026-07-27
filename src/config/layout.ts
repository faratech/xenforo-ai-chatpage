/**
 * Shared reading width for everything that lines up in the chat column:
 * messages, the composer, the activity panel, and the example prompts.
 *
 * It was duplicated as a bare `52rem` in four components, so widening the
 * conversation meant finding all four and keeping them in step — miss one and
 * the composer no longer lines up with the messages above it.
 *
 * A cap is still wanted rather than filling the pane edge to edge: past roughly
 * 100 characters a line, prose gets noticeably harder to track back to the
 * start of the next line.
 */
export const CHAT_CONTENT_MAX_WIDTH = '72rem';
