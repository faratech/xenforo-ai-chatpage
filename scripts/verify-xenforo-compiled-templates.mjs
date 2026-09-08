import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const xenForoRoot = path.resolve(process.argv[2] || '/web/public_html');
const stylesRoot = path.resolve(
  process.argv[3] || path.join(xenForoRoot, 'src/styles'),
);
const manifest = process.env.WF_CHAT_STYLE_MANIFEST ? JSON.parse(process.env.WF_CHAT_STYLE_MANIFEST) : null;
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
// Styles that inherit each tree's chat templates through xf_style
// parent_style_id. This verifier is file-only (it is rsynced to the peer,
// which has no database), so the inheritance chain is mirrored by hand here:
// adding a style that inherits chat templates requires updating this list, and
// keeping it in-repo makes that addition an explicit code change.
const KNOWN_INHERITING_STYLE_IDS = {
  // Style 17 is database-managed but deploy.sh intentionally synchronizes it
  // from the canonical wf3 chat sources on each node. Style 46 has no chat
  // overrides and must compile the inherited wf3 sources as well.
  wf3: [17, 46, 50],
  wf3_domperf: [],
  wf5: [],
};
const styleSpecs = [
  {
    designer: 'wf3',
    sourceTemplates: templates,
    verifyMetadata: true,
  },
  {
    designer: 'wf3_domperf',
    sourceTemplates: templates,
    verifyMetadata: true,
  },
  // WF5 owns only these two bootstraps. deploy.sh updates them with a scoped
  // database sync and deliberately does not rebuild/import all WF5 metadata,
  // so unrelated designer drift remains untouched.
  {
    designer: 'wf5',
    sourceTemplates: bootstrapTemplates,
    verifyMetadata: false,
  },
];
const languageIds = [0, 1];

const md5 = (contents) => createHash('md5').update(contents).digest('hex');

// The xf_style id a tree feeds is its committed .wf-style-id marker (see
// scripts/lib/xenforo-style-id.php, which however prefers a designer_mode DB
// binding over the marker if one were ever re-introduced — so the two sources
// can diverge in principle, and a divergence fails loudly here). A missing or
// unreadable marker fails closed rather than guessing an id.
const readPrimaryStyleId = async (designer) => {
  const markerPath = path.join(stylesRoot, designer, '.wf-style-id');
  let raw;
  try {
    raw = (await readFile(markerPath, 'utf8')).trim();
  } catch (error) {
    throw new Error(
      `${designer}: cannot read the xf_style id marker ${markerPath}: ${error.message}`,
      { cause: error },
    );
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${designer}: ${markerPath} does not name a numeric xf_style id`);
  }
  return Number(raw);
};

let sourceCount = 0;
let compiledConsumerCount = 0;
for (const { designer, sourceTemplates, verifyMetadata } of styleSpecs) {
  if (manifest && !manifest.styles[designer]) continue;
  const templatesRoot = path.join(stylesRoot, designer, 'templates');
  const metadata = verifyMetadata
    ? JSON.parse(await readFile(path.join(templatesRoot, '_metadata.json'), 'utf8'))
    : null;
  const inheritingStyleIds = KNOWN_INHERITING_STYLE_IDS[designer];
  if (!inheritingStyleIds) {
    throw new Error(`${designer} has no KNOWN_INHERITING_STYLE_IDS entry`);
  }
  const compiledStyleIds = [
    ...new Set([await readPrimaryStyleId(designer), ...inheritingStyleIds.filter(id => !manifest || manifest.existing.includes(id))]),
  ];

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
