import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const RELEASE_ASSET_VERSION = '2';

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
      return html
        .replace(
          /\/chatpage\/static\/js\/main\.js(?=["'])/g,
          `/chatpage/static/js/main.js?v=${RELEASE_ASSET_VERSION}`,
        )
        .replace(
          /\/chatpage\/static\/css\/main\.css(?=["'])/g,
          `/chatpage/static/css/main.css?v=${RELEASE_ASSET_VERSION}`,
        );
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
