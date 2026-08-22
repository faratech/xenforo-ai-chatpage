import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const stylesRoot = path.resolve(
  process.argv[2] || '/web/public_html/src/styles',
);
const styles = ['wf3', 'wf3_domperf'];
const chatTemplates = ['_page_node.313', '_widget_ai_chat.html', 'react_chat_container.html'];
const betaChatTemplates = ['_page_node.313', '_widget_ai_chat.html'];
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
let verifiedConsumers = 0;
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
      '<div id="root" class="google-anno-skip" style="min-height:100dvh"></div>',
      'href="https://windowsforum.com/chatpage/static/css/main.css?v=2"',
      'type="module" src="https://windowsforum.com/chatpage/static/js/main.js?v=2"',
    ];
    for (const markup of requiredMarkup) {
      if (!content.includes(markup)) {
        throw new Error(`${style}/${template} is missing ${markup}`);
      }
    }
    verifiedConsumers += 1;
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

// WF5 is independently managed and is never swept by this deploy. When its
// beta source tree is present, still fail preflight if either shared-bundle
// consumer drifts from the stable asset and viewport contract.
const betaTemplatesRoot = path.join(stylesRoot, 'wf5', 'templates', 'public');
let betaTemplatesPresent = true;
try {
  await access(betaTemplatesRoot);
} catch (error) {
  if (error?.code === 'ENOENT') betaTemplatesPresent = false;
  else throw error;
}
if (betaTemplatesPresent) {
  for (const template of betaChatTemplates) {
    const content = await readFile(path.join(betaTemplatesRoot, template), 'utf8');
    for (const markup of [
      'class="google-anno-skip" style="min-height:100dvh"',
      'chatpage/static/css/main.css?v=2',
      'type="module" src="https://windowsforum.com/chatpage/static/js/main.js?v=2"',
    ]) {
      if (!content.includes(markup)) {
        throw new Error(`wf5/${template} is missing ${markup}`);
      }
    }
    verifiedConsumers += 1;
  }
}

console.log(
  `Verified ${verifiedConsumers} XenForo chat consumers; ${changedFiles.length} scoped template changes await the next style-wide sync.`,
);
