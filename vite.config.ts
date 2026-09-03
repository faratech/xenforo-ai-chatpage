import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';

const RELEASE_ASSET_VERSION = '2';
const TELEMETRY_SURFACE = 'chatpage';

const addBuildInput = (hash: ReturnType<typeof createHash>, target: string): void => {
  const stats = statSync(target);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(target).sort()) {
      if (entry === '__tests__') continue;
      addBuildInput(hash, path.join(target, entry));
    }
    return;
  }
  hash.update(path.relative(process.cwd(), target));
  hash.update('\0');
  hash.update(readFileSync(target));
  hash.update('\0');
};

/** One deterministic identifier shared by every telemetry event from a build. */
const resolveBuildId = (mode: string, env: Record<string, string>): string => {
  const explicit = process.env.VITE_BUILD_ID?.trim() || env.VITE_BUILD_ID?.trim();
  if (explicit) return explicit.slice(0, 96);

  const hash = createHash('sha256');
  for (const input of ['src', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts']) {
    addBuildInput(hash, path.resolve(process.cwd(), input));
  }
  hash.update(mode);
  for (const [key, value] of Object.entries(env).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(`\0${key}=${value}`);
  }
  return `chatpage-${hash.digest('hex').slice(0, 20)}`;
};

const validateHttpUrl = (name: string, value: string | undefined): string => {
  if (!value) {
    throw new Error(`${name} must be set for production builds.`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must use http:// or https://.`);
  }

  return url.origin;
};

const validateApiBase = (value: string | undefined): void => {
  if (!value) {
    return;
  }

  if (value.startsWith('/') && !value.startsWith('//')) {
    return;
  }

  validateHttpUrl('VITE_API_BASE', value);
};

const versionStableEntries = (): Plugin => ({
  name: 'version-stable-chatpage-entries',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      let transformed = html
        .replace(
          /\/chatpage\/static\/js\/main\.js(?=["'])/g,
          `/chatpage/static/js/main.js?v=${RELEASE_ASSET_VERSION}`,
        )
        .replace(
          /\/chatpage\/static\/css\/main\.css(?=["'])/g,
          `/chatpage/static/css/main.css?v=${RELEASE_ASSET_VERSION}`,
        );
      let stableStyleSeen = false;
      transformed = transformed.replace(
        /<link\b[^>]*href=["']\/chatpage\/static\/css\/main\.css\?v=2["'][^>]*>/g,
        tag => {
          if (stableStyleSeen) return '';
          stableStyleSeen = true;
          return tag;
        },
      );
      return transformed;
    },
  },
});

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const testDomain = command === 'build'
    ? validateHttpUrl('VITE_TEST_DOMAIN', env.VITE_TEST_DOMAIN)
    : validateHttpUrl(
        'VITE_TEST_DOMAIN',
        env.VITE_TEST_DOMAIN || 'https://test.windowsforum.com',
      );

  if (command === 'build') {
    validateHttpUrl('VITE_DOMAIN', env.VITE_DOMAIN);
    validateApiBase(env.VITE_API_BASE);
  }

  return {
    plugins: [react(), versionStableEntries()],
    define: {
      __WF_BUILD_ID__: JSON.stringify(resolveBuildId(mode, env)),
      __WF_SURFACE__: JSON.stringify(TELEMETRY_SURFACE),
    },
    base: '/chatpage/',
    resolve: {
      alias: {
        src: path.resolve(__dirname, 'src'),
      },
    },
    server: {
      proxy: {
        '^/(chat|tts)\\.php$': {
          target: testDomain,
          changeOrigin: true,
          secure: true,
          cookieDomainRewrite: '',
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      cssCodeSplit: false,
      rollupOptions: {
        output: {
          entryFileNames: 'static/js/main.js',
          chunkFileNames: 'static/js/[name]-[hash].chunk.js',
          assetFileNames: (assetInfo) => {
            if (assetInfo.name?.endsWith('.css')) {
              return 'static/css/main.css';
            }
            return 'static/media/[name]-[hash][extname]';
          },
          manualChunks(id) {
            // Bootstrap and the lazy preferences dialog share the install
            // prompt singleton. Keep it content-hashed so no lazy chunk ever
            // imports the stable main.js release entry.
            if (id.endsWith('/src/services/pwa.ts')) {
              return 'pwa';
            }
            if (id === '\0vite/preload-helper.js') {
              return 'preload-runtime';
            }
            if (id.includes('node_modules/@mui/')) {
              return 'mui';
            }
            if (id.includes('node_modules/@emotion/')) {
              return 'emotion';
            }
            if (
              id.includes('node_modules/react/') ||
              id.includes('node_modules/react-dom/')
            ) {
              return 'vendor';
            }
          },
        },
      },
    },
  };
});
