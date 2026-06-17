#!/bin/bash
# ShopERP Pro — Local WiFi Server
# Double-click this file on Mac to start the server.
# Keep this window open while the shop is running.

cd "$(dirname "$0")/server"

echo ""
echo "  ShopERP Pro — Local Server Setup"
echo "  ─────────────────────────────────"

# Install dependencies if node_modules missing or better-sqlite3 not present
if [ ! -d "node_modules/better-sqlite3" ]; then
  echo "  Installing server packages (first time only, takes ~1 min)..."
  npm install --save better-sqlite3 2>&1 | grep -v "^npm"
  echo "  ✅ Packages installed"
fi

echo ""
echo "  Starting server..."
echo ""

node local.js
