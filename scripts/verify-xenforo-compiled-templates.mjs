import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const xenForoRoot = path.resolve(process.argv[2] || '/web/public_html');
const stylesRoot = path.resolve(
  process.argv[3] || path.join(xenForoRoot, 'src/styles'),
);
const requireChatContract = process.argv.includes('--require-chat-contract');

const templates = [
  '_page_node.313',
  '_widget_ai_chat.html',
  'react_chat_container.html',
];
const bootstrapTemplates = [
  '_page_node.313',
  '_widget_ai_chat.html',
];
const requiredMarkup = requireChatContract ? [
  '<div id="root" class="google-anno-skip" style="min-height:100dvh"></div>',
  'href="https://windowsforum.com/chatpage/static/css/main.css?v=2"',
  'type="module" src="https://windowsforum.com/chatpage/static/js/main.js?v=2"',
] : [];
const styleSpecs = [
  // Style 17 is database-managed but deploy.sh intentionally synchronizes it
  // from the canonical wf3 chat sources on each node. Style 46 has no chat
  // overrides and must compile the inherited wf3 sources as well.
  {
    designer: 'wf3',
    compiledStyleIds: [17, 40, 46, 50],
    sourceTemplates: templates,
    verifyMetadata: true,
  },
  {
    designer: 'wf3_domperf',
    compiledStyleIds: [47],
    sourceTemplates: templates,
    verifyMetadata: true,
  },
  // WF5/style 51 owns only these two bootstraps. deploy.sh updates them with a
  // scoped database sync and deliberately does not rebuild/import all WF5
  // metadata, so unrelated designer drift remains untouched.
  {
    designer: 'wf5',
    compiledStyleIds: [51],
    sourceTemplates: bootstrapTemplates,
    verifyMetadata: false,
  },
];
const languageIds = [0, 1];

const md5 = (contents) => createHash('md5').update(contents).digest('hex');

let sourceCount = 0;
let compiledConsumerCount = 0;
for (const {
  designer,
  compiledStyleIds,
  sourceTemplates,
  verifyMetadata,
} of styleSpecs) {
  const templatesRoot = path.join(stylesRoot, designer, 'templates');
  const metadata = verifyMetadata
    ? JSON.parse(await readFile(path.join(templatesRoot, '_metadata.json'), 'utf8'))
    : null;

  for (const template of sourceTemplates) {
    const sourcePath = path.join(templatesRoot, 'public', template);
    const source = await readFile(sourcePath, 'utf8');
    const sourceHash = md5(source);
    const metadataKey = `public/${template}`;

    if (verifyMetadata && metadata?.[metadataKey]?.hash !== sourceHash) {
      throw new Error(
        `${designer}/${metadataKey} metadata hash does not match the imported source`,
      );
    }
    sourceCount += 1;

    for (const markup of requiredMarkup) {
      if (!source.includes(markup)) {
        throw new Error(`${designer}/${metadataKey} is missing ${markup}`);
      }
    }

    const compiledName = template.endsWith('.html')
      ? template.slice(0, -5)
      : template;

    for (const languageId of languageIds) {
      for (const styleId of compiledStyleIds) {
        const compiledPath = path.join(
          xenForoRoot,
          'internal_data/code_cache/templates',
          `l${languageId}`,
          `s${styleId}`,
          'public',
          `${compiledName}.php`,
        );
        const compiled = await readFile(compiledPath, 'utf8');

        if (!compiled.includes(`// FROM HASH: ${sourceHash}`)) {
          throw new Error(
            `${compiledPath} was not compiled from ${designer}/${metadataKey}`,
          );
        }
        for (const markup of requiredMarkup) {
          if (!compiled.includes(markup)) {
            throw new Error(`${compiledPath} is missing ${markup}`);
          }
        }
        compiledConsumerCount += 1;
      }
    }
  }
}

console.log(
  `Verified ${sourceCount} canonical XenForo chat templates and ${compiledConsumerCount} language/style compiled consumers${requireChatContract ? ' against the current chat contract' : ''}.`,
);
