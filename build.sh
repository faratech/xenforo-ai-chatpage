#!/bin/bash

# Build the React app with consistent filenames
GENERATE_SOURCEMAP=false npm run build

# Rename the files to have consistent names without hashes
cd build/static/js

# Find and rename the main JS file
for file in main.*.js; do
  if [ -f "$file" ]; then
    mv "$file" main.js
  fi
done

# Find and rename chunk files if they exist
for file in *.chunk.js; do
  if [ -f "$file" ]; then
    # Extract the chunk number (e.g., 488 from 488.58c868ee.chunk.js)
    chunk_num=$(echo "$file" | cut -d'.' -f1)
    mv "$file" "${chunk_num}.chunk.js"
  fi
done

cd ../css

# Find and rename the main CSS file
for file in main.*.css; do
  if [ -f "$file" ]; then
    mv "$file" main.css
  fi
done

cd ../../..

# Update the index.html to reference the new filenames
sed -i 's/main\.[a-f0-9]*\.js/main.js/g' build/index.html
sed -i 's/main\.[a-f0-9]*\.css/main.css/g' build/index.html
# Fix the chunk.js reference - capture the number and use it
sed -i 's/\([0-9]*\)\.[a-f0-9]*\.chunk\.js/\1.chunk.js/g' build/index.html

# Also update asset-manifest.json if needed
if [ -f build/asset-manifest.json ]; then
  sed -i 's/main\.[a-f0-9]*\.js/main.js/g' build/asset-manifest.json
  sed -i 's/main\.[a-f0-9]*\.css/main.css/g' build/asset-manifest.json
fi

echo "Build completed with consistent filenames:"
echo "  - /static/js/main.js"
echo "  - /static/css/main.css"
echo "  - /static/js/*.chunk.js (if any)"