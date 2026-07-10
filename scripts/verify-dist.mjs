import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const dist = path.resolve(process.argv[2] || 'dist');
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

console.log(`Verified ${requiredFiles.length} release files, ${referencedFiles.size} HTML references, and ${chunkFiles.length} hashed chunks.`);
