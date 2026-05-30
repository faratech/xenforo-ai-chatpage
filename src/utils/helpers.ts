import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface Citation {
  text: string;
  url: string;
  index: number;
}

/**
 * Sanitizes and parses markdown content with citation extraction
 */
export const sanitizeAndParse = (content: string): string => {
  if (!content) return content;

  let processedContent = content;
  const citations: Citation[] = [];
  let citationIndex = 1;

  const escapeMarkdown = (s: string) => s.replace(/[\\[\]()]/g, '\\$&');

  const citationPattern = /\(?\[([^\]]*)\]\((https?:\/\/[^)]+)\)\)?/g;

  if (content.includes('[')) {
    processedContent = processedContent.replace(citationPattern, (_match, text, url) => {
      if (text.includes('.com') || text.includes('.org') || text.includes('.net')) {
        citations.push({ text: text, url: url, index: citationIndex });
        const ref = `<sup>[${citationIndex}]</sup>`;
        citationIndex++;
        return ref;
      }
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });
  }

  const bareDomainPattern = /\(([a-zA-Z0-9.-]+\.(com|org|net|io|gov|edu)[^)]*)\)/g;
  if (processedContent.includes('(')) {
    processedContent = processedContent.replace(bareDomainPattern, (_match, domain) => {
      if (!citations.some(c => c.text === domain)) {
        citations.push({ text: domain, url: `https://${domain}`, index: citationIndex });
        const ref = `<sup>[${citationIndex}]</sup>`;
        citationIndex++;
        return ref;
      }
      return _match;
    });
  }

  if (citations.length > 0) {
    const citationList = citations.map(c =>
      `<div style="margin: 4px 0;"><small>[${c.index}] <a href="${c.url}" target="_blank" rel="noopener noreferrer" style="color: #4299E1;">${escapeMarkdown(c.text)}</a></small></div>`
    ).join('');
    processedContent += `<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(128,128,128,0.35);">
      <small style="opacity: 0.8;">Sources:</small>
      ${citationList}
    </div>`;
  }

  const rendered = marked(processedContent) as string;
  let sanitized = DOMPurify.sanitize(rendered, { ADD_ATTR: ['aria-hidden'] });
  if (sanitized.trim() === '<p>▍</p>') {
    sanitized = '<p><span aria-hidden="true">▍</span></p>';
  }
  return sanitized;
};

/**
 * Generates a unique conversation ID
 */
export const generateConversationId = (): string => {
  return `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

/**
 * Example prompts for new users
 */
export const EXAMPLE_PROMPTS = [
  "What's the best way to optimize Windows 11 performance?",
  "How do I troubleshoot blue screen errors?",
  "Explain the difference between UEFI and BIOS",
  "How can I secure my Windows computer?",
  "What are the essential Windows keyboard shortcuts?",
];

/**
 * Extracts plain text from HTML content
 */
export const extractTextFromHTML = (html: string): string => {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;
  return tempDiv.textContent || tempDiv.innerText || '';
};
