/** Lightweight IDs used before the Markdown/rendering stack is loaded. */
export const generateConversationId = (): string =>
  `conv_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

/** Correlates one logical turn across retries, PHP, and upstream logs. */
export const generateTurnId = (): string =>
  Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
