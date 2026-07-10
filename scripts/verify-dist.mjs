import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const dist = path.resolve(process.argv[2] || 'dist');
const CONTAINER_ID = '#react-chat-container';
const requiredFiles = [
  '.htaccess',
  'bot-avatar.webp',
  'index.html',
  'manifest.json',
  'static/js/main.js',
  'static/css/main.css',
];

await Promise.all(requiredFiles.map(file => access(path.join(dist, file))));

const html = await readFile(path.join(dist, 'index.html'), 'utf8');
const manifest = JSON.parse(
  await readFile(path.join(dist, 'manifest.json'), 'utf8'),
);
if (
  manifest.name !== 'WindowsForum AI Chat'
  || manifest.start_url !== '/chatpage/'
  || manifest.scope !== '/chatpage/'
) {
  throw new Error('Web manifest branding or chatpage scope is invalid.');
}
for (const icon of manifest.icons || []) {
  await access(path.join(dist, icon.src));
}

const requiredMarkup = [
  /<div id="root"><\/div>/,
  /<script type="module"[^>]+src="\/chatpage\/static\/js\/main\.js\?v=2"/,
  /<link rel="stylesheet"[^>]+href="\/chatpage\/static\/css\/main\.css\?v=2"/,
];

for (const pattern of requiredMarkup) {
  if (!pattern.test(html)) {
    throw new Error(`Built index.html is missing required markup: ${pattern}`);
  }
}

const referencedFiles = new Set();
for (const match of html.matchAll(/(?:src|href)="\/chatpage\/([^"?#]+)(?:[?#][^"]*)?"/g)) {
  referencedFiles.add(match[1]);
}

await Promise.all(
  [...referencedFiles].map(file => access(path.join(dist, file))),
);

const jsFiles = await readdir(path.join(dist, 'static/js'));
const chunkFiles = jsFiles.filter(file => file.endsWith('.chunk.js'));
if (chunkFiles.length === 0) {
  throw new Error('Expected at least one content-hashed JavaScript chunk.');
}

for (const file of chunkFiles) {
  if (!/-[A-Za-z0-9_-]{8,}\.chunk\.js$/.test(file)) {
    throw new Error(`JavaScript chunk is not content hashed: ${file}`);
  }
}

const mediaDir = path.join(dist, 'static/media');
try {
  const mediaFiles = await readdir(mediaDir);
  for (const file of mediaFiles) {
    if (!/-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(file)) {
      throw new Error(`Bundled media is not content hashed: ${file}`);
    }
  }
} catch (error) {
  if (error?.code !== 'ENOENT') {
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Static import graph: every local import specifier in the emitted JS must
// resolve to a file inside dist. Catches stale/missing chunks that would only
// fail at runtime in the browser.
// ---------------------------------------------------------------------------

const importPatterns = [
  /\bfrom\s*(["'])([^"']+)\1/g, // import { x } from "./a.chunk.js"
  /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g, // import("./a.chunk.js")
  /(?:^|[^.\w$])import\s*(["'])([^"']+)\1/g, // import"./a.chunk.js"
];

const resolveSpecifier = (specifier, importerDir) => {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return path.resolve(importerDir, specifier);
  }
  if (specifier.startsWith('/chatpage/')) {
    return path.join(dist, specifier.slice('/chatpage/'.length));
  }
  if (specifier.startsWith('/')) {
    return path.join(dist, specifier);
  }
  return null; // bare specifier (external); not a dist reference
};

let importSpecifierCount = 0;
const jsDir = path.join(dist, 'static/js');
for (const file of jsFiles.filter(name => name.endsWith('.js'))) {
  const filePath = path.join(jsDir, file);
  const source = await readFile(filePath, 'utf8');
  const seen = new Set();
  for (const pattern of importPatterns) {
    for (const match of source.matchAll(pattern)) {
      seen.add(match[2]);
    }
  }
  for (const specifier of seen) {
    const resolved = resolveSpecifier(specifier, jsDir);
    if (resolved === null) {
      continue;
    }
    importSpecifierCount += 1;
    try {
      await access(resolved);
    } catch {
      throw new Error(
        `static/js/${file} imports a missing file: "${specifier}" (resolved to ${resolved})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// CSS scoping: main.css must not leak global styles into XenForo pages.
// Allowed constructs:
//   - style rules whose every comma-separated selector contains
//     `#react-chat-container`
//   - @media / @supports whose inner rules satisfy the same
//   - @keyframes whose names match /^wf[A-Za-z0-9]/
//   - a leading @charset statement
// Everything else (bare `body`, `*`, `:root`, `.MuiX`, `@font-face`,
// `@import`, ...) throws with the offending selector in the message.
// Implemented with a small tolerant tokenizer (string/comment aware brace
// scanning) — intentionally no CSS npm dependency.
// ---------------------------------------------------------------------------

const stripCssComments = text => text.replace(/\/\*[\s\S]*?\*\//g, ' ');

const parseCssBlock = css => {
  const nodes = [];
  let i = 0;
  const n = css.length;

  const skipString = quote => {
    i += 1;
    while (i < n) {
      if (css[i] === '\\') {
        i += 2;
        continue;
      }
      if (css[i] === quote) {
        i += 1;
        return;
      }
      i += 1;
    }
  };

  const skipComment = () => {
    const end = css.indexOf('*/', i + 2);
    i = end === -1 ? n : end + 2;
  };

  while (i < n) {
    const c = css[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '/' && css[i + 1] === '*') {
      skipComment();
      continue;
    }

    // Read a prelude up to `{` (rule) or `;` (statement).
    const start = i;
    let prelude = null;
    let isStatement = false;
    while (i < n) {
      const ch = css[i];
      if (ch === '"' || ch === "'") {
        skipString(ch);
        continue;
      }
      if (ch === '/' && css[i + 1] === '*') {
        skipComment();
        continue;
      }
      if (ch === '{') {
        prelude = css.slice(start, i);
        i += 1;
        break;
      }
      if (ch === ';') {
        prelude = css.slice(start, i);
        isStatement = true;
        i += 1;
        break;
      }
      i += 1;
    }
    if (prelude === null) {
      // Trailing garbage without a block; treat as a statement.
      prelude = css.slice(start);
      isStatement = true;
    }

    if (isStatement) {
      const text = stripCssComments(prelude).trim();
      if (text.length > 0) {
        nodes.push({ type: 'statement', text });
      }
      continue;
    }

    // Consume the balanced body.
    const bodyStart = i;
    let depth = 1;
    while (i < n && depth > 0) {
      const ch = css[i];
      if (ch === '"' || ch === "'") {
        skipString(ch);
        continue;
      }
      if (ch === '/' && css[i + 1] === '*') {
        skipComment();
        continue;
      }
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
      }
      i += 1;
    }
    if (depth !== 0) {
      throw new Error('main.css has unbalanced braces; refusing to verify.');
    }
    const body = css.slice(bodyStart, i - 1);
    nodes.push({
      type: 'rule',
      prelude: stripCssComments(prelude).trim(),
      body,
    });
  }
  return nodes;
};

const splitSelectors = prelude => {
  const selectors = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < prelude.length; i += 1) {
    const c = prelude[i];
    if (c === '(' || c === '[') {
      depth += 1;
    } else if (c === ')' || c === ']') {
      depth -= 1;
    }
    if (c === ',' && depth === 0) {
      selectors.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  selectors.push(current);
  return selectors.map(s => s.trim()).filter(s => s.length > 0);
};

let cssRuleCount = 0;
const validateCssNodes = (nodes, context) => {
  for (const node of nodes) {
    if (node.type === 'statement') {
      if (/^@charset\b/i.test(node.text)) {
        continue; // encoding pragma; cannot leak styles
      }
      throw new Error(
        `Disallowed CSS statement in main.css${context}: "${node.text}"`,
      );
    }

    const prelude = node.prelude;
    if (prelude.startsWith('@')) {
      const match = /^@(-[a-z]+-)?([a-z-]+)/i.exec(prelude);
      const name = match ? match[2].toLowerCase() : '';
      if (name === 'media' || name === 'supports') {
        validateCssNodes(parseCssBlock(node.body), `${context} inside "${prelude}"`);
        continue;
      }
      if (name === 'keyframes') {
        const keyframesName = prelude
          .replace(/^@(-[a-z]+-)?keyframes/i, '')
          .trim();
        if (!/^wf[A-Za-z0-9]/.test(keyframesName)) {
          throw new Error(
            `@keyframes name must start with "wf" in main.css${context}: "${keyframesName || prelude}"`,
          );
        }
        cssRuleCount += 1;
        continue;
      }
      if (name === 'font-face') {
        throw new Error(`@font-face is forbidden in main.css${context}.`);
      }
      throw new Error(
        `Disallowed at-rule in main.css${context}: "${prelude}"`,
      );
    }

    for (const selector of splitSelectors(prelude)) {
      if (!selector.includes(CONTAINER_ID)) {
        throw new Error(
          `Unscoped CSS selector in main.css${context}: "${selector}" (every selector must contain ${CONTAINER_ID})`,
        );
      }
    }
    cssRuleCount += 1;
  }
};

const cssText = await readFile(path.join(dist, 'static/css/main.css'), 'utf8');
validateCssNodes(parseCssBlock(cssText), '');

console.log(
  `Verified ${requiredFiles.length} release files, ${referencedFiles.size} HTML references, `
  + `${chunkFiles.length} hashed chunks, ${importSpecifierCount} local import specifiers, `
  + `and ${cssRuleCount} scoped CSS rules.`,
);
