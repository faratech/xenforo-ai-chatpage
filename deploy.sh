#!/bin/bash

# Deploy script for XenForo AI Chat Page

echo "Starting deployment process..."

# Run the build with consistent filenames
echo "Building application..."
./build.sh

# Copy files to deployment directory
echo "Deploying to /web/public_html/chatpage/..."
cp -r build/* /web/public_html/chatpage/

# Set proper permissions
chmod -R 755 /web/public_html/chatpage/

echo "Deployment complete!"
echo "Application available at: https://windowsforum.com/chatpage"
echo ""
echo "Deployed files:"
ls -lh /web/public_html/chatpage/static/js/main.js
ls -lh /web/public_html/chatpage/static/css/main.css