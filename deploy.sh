#!/bin/bash

# Deploy script for XenForo AI Chat Page

echo "Starting deployment process..."

# Run the Vite build
echo "Building application..."
npx vite build || { echo "Build failed! Aborting deploy."; exit 1; }

# Copy files to deployment directory
echo "Deploying to /web/public_html/chatpage/..."
rm -rf /web/public_html/chatpage/*
cp -r dist/* /web/public_html/chatpage/

# Set proper permissions
chmod -R 755 /web/public_html/chatpage/

echo "Deployment complete!"
echo "Application available at: https://windowsforum.com/chatpage"
echo ""
echo "Deployed files:"
ls -lh /web/public_html/chatpage/static/js/main.js
ls -lh /web/public_html/chatpage/static/css/main.css
