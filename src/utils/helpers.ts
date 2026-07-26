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
// Approved image host: the windowsforum.com apex and any of its subdomains
// (data./test./cdn./…) over HTTPS. The leading dot in the suffix check is
// what rejects look-alikes like notwindowsforum.com and
// windowsforum.com.attacker.example.
const AI_IMAGE_HOST = 'windowsforum.com';

const isApprovedImageOrigin = (url: URL): boolean =>
  url.protocol === 'https:'
  && (url.hostname === AI_IMAGE_HOST || url.hostname.endsWith(`.${AI_IMAGE_HOST}`));

// The assistant emits HTML rather than Markdown for images and links — the
// backend literally instructs it to (`responses_router.py`, chat surface).
// Those tags are recognized by tokenizer extensions (see sanitizeAndParse)
// that turn them into native Marked tokens, so they flow through the same
// hardened image()/link() renderers as Markdown syntax. The security contract:
//
//   1. Never echo a matched tag's own text; always rebuild from parsed
//      attributes. A malformed tag must not smuggle an attribute through.
//   2. Only src/alt survive from <img>, only href/title from <a>. Never
//      class — it is in ALLOWED_MARKDOWN_ATTRIBUTES for code fences, and this
//      page renders inside XenForo, so a class name reaches the host stylesheet.
//   3. A raw tag is honored only when its closing tag is in the same token.
//      An unbalanced tag would be re-opened across every later block by the
//      HTML5 adoption agency, wrapping the whole answer (and the Sources
//      footer) in one attacker-controlled element.
//   4. html() never emits markup. Everything a tokenizer rejects falls through
//      to it and is escaped.
//
// A `>` inside a quoted attribute value must not terminate the tag: breadcrumb
// captions ("Task Manager > Startup apps") are routine and used to break this.
const rawTagPattern = (name: string): RegExp => new RegExp(
  `^<${name}((?:\\s+[^\\s=/>]+(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'\`=<>]+))?)*)\\s*/?>`,
  'i',
);

const RAW_IMG_TAG = rawTagPattern('img');
const RAW_ANCHOR_TAG = rawTagPattern('a');
const RAW_ANCHOR_CLOSE = /<\/a\s*>/i;
const RAW_ANCHOR_CLOSE_AT_START = /^<\/a\s*>/i;
const RAW_ANCHOR_OPEN_AHEAD = /<a[\s>]/i;
const RAW_BR_TAG = /^<br\s*\/?>/i;
const TAG_ATTRIBUTE = /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;

// Inline formatting the assistant sometimes writes as HTML, mapped to the
// Marked token that renders it. Only balanced pairs are honored.
const RAW_FORMAT_TOKENS: Record<string, string> = {
  b: 'strong',
  code: 'codespan',
  del: 'del',
  em: 'em',
  i: 'em',
  strong: 'strong',
};
const RAW_FORMAT_OPEN = /^<(b|code|del|em|i|strong)\s*>/i;
const RAW_LIST_BLOCK = /^<(ol|ul)\s*>([\s\S]*?)<\/\1\s*>/i;
const RAW_LIST_ITEM = /<li\s*>([\s\S]*?)<\/li\s*>/gi;

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const parseHttpUrl = (value: string): URL | null => {
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
    && isApprovedImageOrigin(url)
    && AI_IMAGE_PATH_PATTERN.test(url.pathname);
};

/**
 * Attribute map for a matched tag's attribute source, names lower-cased and
 * first occurrence winning (as the HTML parser does). Only ever used to read
 * values back out — never to re-emit the original markup.
 */
const parseTagAttributes = (attributeSource: string): Map<string, string> => {
  const attributes = new Map<string, string>();
  TAG_ATTRIBUTE.lastIndex = 0;
  let match = TAG_ATTRIBUTE.exec(attributeSource);
  while (match) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) {
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
    }
    match = TAG_ATTRIBUTE.exec(attributeSource);
  }
  return attributes;
};

/**
 * Reads a raw <img> at the start of `source`. Returns null unless the tag is
 * well formed and its src is an approved AI image — malformed markup fails
 * closed, so it stays escaped rather than being guessed at.
 */
const approvedRawImageTag = (
  source: string,
): { raw: string; href: string; alt: string } | null => {
  const match = RAW_IMG_TAG.exec(source);
  if (!match) return null;
  const attributes = parseTagAttributes(match[1]);
  const href = attributes.get('src') ?? '';
  if (!isApprovedAiImage(href)) return null;
  return { raw: match[0], href, alt: attributes.get('alt') ?? 'Windows screenshot' };
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
        // Raw HTML never renders. The tags we do honor are recognized earlier,
        // by the tokenizer extensions below; anything reaching here (scripts,
        // forms, iframes, comments, unbalanced tags) is inert text.
        return escapeHtml(text);
      },
      link({ href, title, text, tokens }) {
        if (isApprovedAiImage(href) && href === text) {
          return `<img src="${escapeHtml(href)}" alt="Windows screenshot">`;
        }

        const label = this.parser.parseInline(tokens);
        if (!isSafeLink(href)) return label;
        // Only a plain-text label can be a citation. `text` is the label's raw
        // source, so a link wrapping an image would otherwise match on the URL
        // inside it and collapse the image into a bogus citation.
        const isPlainTextLabel = tokens.length === 1 && tokens[0].type === 'text';
        if (isPlainTextLabel && parseHttpUrl(href) && CITATION_LABEL_PATTERN.test(text)) {
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
    extensions: [
      {
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
      },
      {
        // A standalone raw <img> line. Block extensions run before Marked's
        // block-HTML rule (which would swallow the following lines into one
        // escaped token) but after fences and indented code have claimed their
        // regions, so an <img> inside a code block stays literal.
        // Deliberately no `start`: <img> does not interrupt a paragraph, so
        // prose followed by an image stays one paragraph and a heading after
        // the image still lexes as a heading.
        name: 'rawImageBlock',
        level: 'block',
        tokenizer(source) {
          if (!/^<img\b/i.test(source)) return undefined;
          const tag = approvedRawImageTag(source);
          if (!tag) return undefined;
          const lineEnd = /^[ \t]*(?:\n|$)/.exec(source.slice(tag.raw.length));
          if (!lineEnd) return undefined;
          return {
            type: 'paragraph',
            raw: tag.raw + lineEnd[0],
            text: tag.raw,
            tokens: [{ type: 'image', raw: tag.raw, href: tag.href, title: null, text: tag.alt }],
          };
        },
      },
      {
        name: 'rawImageInline',
        level: 'inline',
        start(source) {
          const index = source.search(/<img\b/i);
          return index < 0 ? undefined : index;
        },
        tokenizer(source) {
          if (!/^<img\b/i.test(source)) return undefined;
          const tag = approvedRawImageTag(source);
          if (!tag) return undefined;
          return { type: 'image', raw: tag.raw, href: tag.href, title: null, text: tag.alt };
        },
      },
      {
        // A balanced <a …>…</a>. Emitting a native link token routes it through
        // link() above, so it inherits href vetting, target/rel, and citation
        // extraction. An unbalanced or nested anchor is rejected outright.
        name: 'rawAnchor',
        level: 'inline',
        start(source) {
          const index = source.search(RAW_ANCHOR_OPEN_AHEAD);
          return index < 0 ? undefined : index;
        },
        tokenizer(source) {
          if (this.lexer.state.inLink) return undefined;
          const open = RAW_ANCHOR_TAG.exec(source);
          if (!open) return undefined;
          const attributes = parseTagAttributes(open[1]);
          const href = attributes.get('href');
          if (href === undefined || !isSafeLink(href)) return undefined;

          const rest = source.slice(open[0].length);
          const closeIndex = rest.search(RAW_ANCHOR_CLOSE);
          if (closeIndex < 0) return undefined;
          const label = rest.slice(0, closeIndex);
          if (RAW_ANCHOR_OPEN_AHEAD.test(label)) return undefined;
          const close = RAW_ANCHOR_CLOSE_AT_START.exec(rest.slice(closeIndex));
          if (!close) return undefined;

          this.lexer.state.inLink = true;
          const tokens = this.lexer.inlineTokens(label);
          this.lexer.state.inLink = false;

          return {
            type: 'link',
            raw: source.slice(0, open[0].length + closeIndex + close[0].length),
            href,
            title: attributes.get('title') ?? null,
            text: label,
            tokens,
          };
        },
      },
      {
        name: 'rawFormat',
        level: 'inline',
        start(source) {
          const index = source.search(/<(?:b|code|del|em|i|strong)\s*>/i);
          return index < 0 ? undefined : index;
        },
        tokenizer(source) {
          const open = RAW_FORMAT_OPEN.exec(source);
          if (!open) return undefined;
          const tag = open[1].toLowerCase();
          const rest = source.slice(open[0].length);
          const closeIndex = rest.search(new RegExp(`</${tag}\\s*>`, 'i'));
          if (closeIndex < 0) return undefined;
          const inner = rest.slice(0, closeIndex);
          if (new RegExp(`<${tag}[\\s>]`, 'i').test(inner)) return undefined;
          const close = new RegExp(`^</${tag}\\s*>`, 'i').exec(rest.slice(closeIndex));
          if (!close) return undefined;

          const raw = source.slice(0, open[0].length + closeIndex + close[0].length);
          const type = RAW_FORMAT_TOKENS[tag];
          if (type === 'codespan') return { type, raw, text: inner };
          return { type, raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
        },
      },
      {
        name: 'rawBr',
        level: 'inline',
        start(source) {
          const index = source.search(/<br\b/i);
          return index < 0 ? undefined : index;
        },
        tokenizer(source) {
          const match = RAW_BR_TAG.exec(source);
          if (!match) return undefined;
          return { type: 'br', raw: match[0] };
        },
      },
      {
        // A balanced <ul>/<ol> whose body is nothing but <li> items. Any stray
        // content between the items rejects the whole block, so a list is never
        // a vehicle for markup that would otherwise be escaped.
        name: 'rawList',
        level: 'block',
        tokenizer(source) {
          const match = RAW_LIST_BLOCK.exec(source);
          if (!match) return undefined;
          const body = match[2];
          RAW_LIST_ITEM.lastIndex = 0;
          const items = [...body.matchAll(RAW_LIST_ITEM)];
          if (items.length === 0) return undefined;
          if (body.replace(RAW_LIST_ITEM, '').trim() !== '') return undefined;

          return {
            type: 'list',
            raw: match[0],
            ordered: match[1].toLowerCase() === 'ol',
            start: 1,
            loose: false,
            items: items.map(item => ({
              type: 'list_item',
              raw: item[0],
              task: false,
              checked: undefined,
              loose: false,
              text: item[1],
              tokens: [{
                type: 'text',
                raw: item[1],
                text: item[1],
                tokens: this.lexer.inlineTokens(item[1].trim()),
              }],
            })),
          };
        },
      },
    ],
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
