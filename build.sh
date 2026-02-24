#!/bin/bash

# Build the React app with Vite (consistent filenames configured in vite.config.ts)
npx vite build

echo "Build completed with consistent filenames:"
echo "  - /static/js/main.js"
echo "  - /static/css/main.css"
echo "  - /static/js/*.chunk.js (if any)"
