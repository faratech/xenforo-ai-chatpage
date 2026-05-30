import { describe, it, expect } from 'vitest';
import {
  sanitizeAndParse,
  generateConversationId,
  extractTextFromHTML,
} from '../utils/helpers';

describe('helpers smoke tests', () => {
  it('sanitizeAndParse renders bold markdown and strips scripts', () => {
    const out = sanitizeAndParse('Hello **world**');
    expect(out).toContain('<strong>world</strong>');
    expect(out).not.toContain('<script>');
  });

  it('sanitizeAndParse returns empty string for empty input', () => {
    expect(sanitizeAndParse('')).toBe('');
  });

  it('sanitizeAndParse emits a Sources block with safe rel attributes', () => {
    const out = sanitizeAndParse('[example.com](https://example.com)');
    expect(out).toContain('Sources');
    expect(out).toContain('noopener noreferrer');
  });

  it('generateConversationId matches the expected id format', () => {
    expect(generateConversationId()).toMatch(/^conv_\d+_[a-z0-9]+$/);
  });

  it('extractTextFromHTML returns the plain text content', () => {
    expect(extractTextFromHTML('<p>hi</p>')).toBe('hi');
  });
});
