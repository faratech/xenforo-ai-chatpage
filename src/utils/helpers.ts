import { Marked } from 'marked';
import DOMPurify from 'dompurify';

interface Citation {
  text: string;
  url: string;
  index: number;
}

const ALLOWED_MARKDOWN_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'small',
  'span',
  'strong',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
];

const ALLOWED_MARKDOWN_ATTRIBUTES = [
  'align',
  'alt',
  'aria-hidden',
  'class',
  'href',
  'rel',
  'src',
  'start',
  'target',
  'title',
];

const CITATION_LABEL_PATTERN = /(?:^|\b)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+(?:com|org|net|io|gov|edu)(?:\b|$)/i;
const BARE_CITATION_PATTERN = /^\(((?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+(?:com|org|net|io|gov|edu)(?:\/[^\s<>()]*)?)\)/i;
const AI_IMAGE_PATH_PATTERN = /^\/images\/ai\/(?:answers|walkthroughs|screenshots)\/.+\.(?:avif|gif|jpe?g|png|webp)$/i;
const AI_IMAGE_ORIGINS = new Set([
  'https://windowsforum.com',
  'https://test.windowsforum.com',
]);

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const parseHttpUrl = (value: string): URL | null => {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
};

const isSafeLink = (href: string): boolean => {
  if (href.startsWith('#') || href.startsWith('?')) return true;
  if (href.startsWith('/') && !href.startsWith('//')) return true;
  if (/^(?:mailto:|tel:)/i.test(href)) return true;
  return parseHttpUrl(href) !== null;
};

const isApprovedAiImage = (href: string): boolean => {
  const url = parseHttpUrl(href);
  return url !== null
    && AI_IMAGE_ORIGINS.has(url.origin)
    && AI_IMAGE_PATH_PATTERN.test(url.pathname);
};

const linkAttributes = (href: string, title?: string | null): string => {
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
  const externalAttributes = parseHttpUrl(href)
    ? ' target="_blank" rel="noopener noreferrer"'
    : '';
  return `href="${escapeHtml(href)}"${titleAttribute}${externalAttributes}`;
};

/**
 * Sanitizes and parses markdown content with citation extraction
 */
export const sanitizeAndParse = (content: string): string => {
  if (!content) return content;

  const citations: Citation[] = [];
  const citationIndexes = new Map<string, number>();

  const renderCitation = (text: string, url: string): string => {
    const parsedUrl = parseHttpUrl(url);
    if (!parsedUrl) return escapeHtml(text);

    const key = parsedUrl.href;
    let index = citationIndexes.get(key);
    if (index === undefined) {
      index = citations.length + 1;
      citationIndexes.set(key, index);
      citations.push({ text, url, index });
    }
    return `<sup>[${index}]</sup>`;
  };

  const markdown = new Marked({
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
      link({ href, title, text, tokens }) {
        if (isApprovedAiImage(href) && href === text) {
          return `<img src="${escapeHtml(href)}" alt="Windows screenshot">`;
        }

        const label = this.parser.parseInline(tokens);
        if (!isSafeLink(href)) return label;
        if (parseHttpUrl(href) && CITATION_LABEL_PATTERN.test(text)) {
          return renderCitation(text, href);
        }
        return `<a ${linkAttributes(href, title)}>${label}</a>`;
      },
      image({ href, text, title }) {
        if (!isApprovedAiImage(href)) return escapeHtml(text || href);
        const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleAttribute}>`;
      },
    },
    extensions: [{
      name: 'bareCitation',
      level: 'inline',
      start(source) {
        return source.indexOf('(');
      },
      tokenizer(source) {
        if (this.lexer.state.inLink) return undefined;
        const match = BARE_CITATION_PATTERN.exec(source);
        if (!match) return undefined;
        return {
          type: 'bareCitation',
          raw: match[0],
          text: match[1],
          href: `https://${match[1]}`,
        };
      },
      renderer(token) {
        return renderCitation(String(token.text), String(token.href));
      },
    }],
  });

  let rendered = markdown.parse(content, { async: false });

  if (citations.length > 0) {
    const citationList = citations.map(c =>
      `<small>[${c.index}] <a ${linkAttributes(c.url)}>${escapeHtml(c.text)}</a></small>`
    ).join('<br>');
    rendered += `<hr><p><small>Sources:</small><br>${citationList}</p>`;
  }

  let sanitized = DOMPurify.sanitize(rendered, {
    ALLOWED_TAGS: ALLOWED_MARKDOWN_TAGS,
    ALLOWED_ATTR: ALLOWED_MARKDOWN_ATTRIBUTES,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: ['style'],
    FORBID_TAGS: ['button', 'form', 'iframe', 'input', 'object', 'style', 'svg'],
  });
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
