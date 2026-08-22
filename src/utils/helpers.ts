import { Marked } from 'marked';
import DOMPurify from 'dompurify';
export { generateConversationId, generateTurnId } from './ids';

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

/**
 * Inline citations arrive as a private-use-area token rather than as markdown:
 * U+E200 `cite` U+E202 <payload> U+E201. Browsers render U+E2xx as nothing (or
 * as tofu), so an untouched token reaches the reader as the bare word "cite"
 * followed by a raw URL in the middle of a sentence.
 *
 * The payload is one or more URLs. Anything else the model wraps this way
 * (`navlist`, and whatever gets added next) is internal markup that was never
 * meant to be displayed, so it is dropped rather than guessed at.
 */
const CITATION_TOKEN = /\uE200([a-z]*)\uE202([\s\S]*?)\uE201/g;
/** The same token still arriving — no closing delimiter yet. */
const OPEN_CITATION_TOKEN = /\uE200([a-z]*)(?:\uE202([\s\S]*))?$/;
/** Any delimiter that outlived the rules above must not reach the reader. */
const RESIDUAL_MARKER = /[\uE200-\uE20F]/g;

const citationTokenToMarkdown = (kind: string, payload: string): string => {
  if (kind.toLowerCase() !== 'cite' || !payload) return '';
  const links = payload
    .split(/[\uE200-\uE20F\s]+/)
    .map(parseHttpUrl)
    .filter((url): url is URL => url !== null)
    // The hostname is the label the existing citation renderer looks for, so a
    // converted token collapses to the same numbered superscript and Sources
    // entry as a citation the model wrote as markdown.
    .map(url => `[${url.hostname.replace(/^www\./, '')}](${url.href})`);
  return links.length ? ` ${links.join(' ')}` : '';
};

/**
 * Turns the citation tokens above into markdown the renderer already
 * understands, and removes everything else in that private-use range.
 *
 * `streaming` decides what to do with a token that is still arriving: mid
 * stream it is held back until its closing delimiter lands, so the reader never
 * sees "cite" flash before the URL catches up. On a finished message there is
 * nothing more coming, so whatever arrived is converted as-is.
 */
export const normalizeAssistantMarkup = (content: string, streaming = false): string => {
  // Costs one indexOf on the overwhelming majority of messages, which matters
  // because the streaming path re-runs this every animation frame.
  if (!content || !content.includes('\uE200')) return content;

  let normalized = content;

  // While streaming, a token whose closing delimiter has not landed must be
  // held back wholesale \u2014 whatever follows the opener is payload-in-progress.
  // The end-of-string anchored pattern below only catches an opener that sits
  // flush against the tail; anything else (an uppercase or odd kind, a stray
  // extra marker) slipped past it and leaked literal internal markup
  // mid-sentence until the closing delimiter arrived.
  if (streaming) {
    const lastOpen = normalized.lastIndexOf('\uE200');
    if (lastOpen !== -1 && !normalized.includes('\uE201', lastOpen)) {
      normalized = normalized.slice(0, lastOpen);
      if (!normalized.includes('\uE200')) return normalized;
    }
  }

  normalized = normalized.replace(
    CITATION_TOKEN,
    (_full, kind: string, payload: string) => citationTokenToMarkdown(kind, payload)
  );

  normalized = normalized.replace(
    OPEN_CITATION_TOKEN,
    (_full, kind: string, payload: string) => (
      streaming ? '' : citationTokenToMarkdown(kind, payload ?? '')
    )
  );

  return normalized.replace(RESIDUAL_MARKER, '');
};

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

/**
 * Stable identity for source deduplication. Keep navigation pointed at the
 * original cited URL, but ignore presentation-only differences that commonly
 * make the same document arrive more than once.
 */
export const canonicalHttpUrlKey = (value: string): string | null => {
  const url = parseHttpUrl(value);
  if (!url) return null;

  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_[a-z\d_]+|fbclid|gclid|dclid|msclkid)$/i.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
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
  content = normalizeAssistantMarkup(content);

  const citations: Citation[] = [];
  const citationIndexes = new Map<string, number>();

  const renderCitation = (text: string, url: string): string => {
    const parsedUrl = parseHttpUrl(url);
    if (!parsedUrl) return escapeHtml(text);

    const key = canonicalHttpUrlKey(parsedUrl.href) ?? parsedUrl.href;
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

/** An opening or closing code fence, allowing CommonMark's 3-space indent. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Splits streaming content into the part that is safe to render as Markdown
 * and the tail that is not finished yet.
 *
 * The boundary is the last blank line that is not inside an open code fence.
 * Markdown separates block constructs on blank lines, so everything before one
 * is structurally complete and cannot be changed by text that arrives later —
 * which is exactly the property needed to format a response as it streams
 * without the whole message re-flowing when it ends.
 *
 * The tail is returned verbatim for the caller to render as plain text; it is
 * never handed to the Markdown parser, so a half-written fence, link, or table
 * cannot render as markup mid-stream.
 */
export const splitStreamingMarkdown = (content: string): { closed: string; trailing: string } => {
  if (!content) return { closed: '', trailing: '' };
  // Streaming: an unterminated token is held back rather than shown half-built.
  // The trailing half of the split renders as escaped plain text, so a token
  // left in it would reach the reader verbatim.
  content = normalizeAssistantMarkup(content, true);

  const lines = content.split('\n');
  let openFence: string | null = null;
  let boundary = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const fence = FENCE_LINE.exec(lines[index]);
    if (fence) {
      if (openFence === null) {
        openFence = fence[1];
      } else if (fence[1][0] === openFence[0] && fence[1].length >= openFence.length) {
        openFence = null;
      }
      continue;
    }
    // A boundary is only recorded outside a fence, so a blank line inside an
    // unterminated code block never becomes a split point.
    if (openFence === null && lines[index].trim() === '') boundary = index;
  }

  if (boundary < 0) return { closed: '', trailing: content };

  return {
    closed: lines.slice(0, boundary).join('\n'),
    trailing: lines.slice(boundary + 1).join('\n'),
  };
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
