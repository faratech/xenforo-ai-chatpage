import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const stylesRoot = path.resolve(
  process.argv[2] || '/web/public_html/src/styles',
);
const styles = ['wf3', 'wf3_domperf'];
const chatTemplates = ['_page_node.313', '_widget_ai_chat.html', 'react_chat_container.html'];
const allowedContentChanges = new Set(
  styles.flatMap(style => chatTemplates.map(
    template => `${style}/public/${template}`,
  )),
);

const collectFiles = async (directory, prefix = '') => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('_metadata.') || entry.name.startsWith('.')) {
      continue;
    }
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(path.join(directory, entry.name), relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
};

const changedFiles = [];
for (const style of styles) {
  const templatesRoot = path.join(stylesRoot, style, 'templates');
  const metadata = JSON.parse(
    await readFile(path.join(templatesRoot, '_metadata.json'), 'utf8'),
  );

  for (const template of chatTemplates) {
    const content = await readFile(
      path.join(templatesRoot, 'public', template),
      'utf8',
    );
    const requiredMarkup = [
      '<div id="root"></div>',
      'href="https://windowsforum.com/chatpage/static/css/main.css?v=2"',
      'type="module" src="https://windowsforum.com/chatpage/static/js/main.js?v=2"',
    ];
    for (const markup of requiredMarkup) {
      if (!content.includes(markup)) {
        throw new Error(`${style}/${template} is missing ${markup}`);
      }
    }
  }

  for (const file of await collectFiles(templatesRoot)) {
    const content = await readFile(path.join(templatesRoot, file));
    const hash = createHash('md5').update(content).digest('hex');
    if (metadata[file]?.hash !== hash) {
      const scopedName = `${style}/${file}`;
      changedFiles.push(scopedName);
      if (!allowedContentChanges.has(scopedName)) {
        throw new Error(
          `Refusing a style-wide sync because unrelated template content changed: ${scopedName}`,
        );
      }
    }
  }
}

console.log(
  `Verified six XenForo chat consumers; ${changedFiles.length} scoped template changes await normal designer sync.`,
);
