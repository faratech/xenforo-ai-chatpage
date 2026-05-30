import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: '/chatpage/',
  resolve: {
    alias: {
      src: path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Consistent filenames without hashes (replaces build.sh hash-stripping)
        entryFileNames: 'static/js/main.js',
        chunkFileNames: 'static/js/[name].chunk.js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.css')) {
            return 'static/css/main.css';
          }
          return 'static/media/[name][extname]';
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
});
