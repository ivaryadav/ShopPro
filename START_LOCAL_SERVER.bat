@echo off
title ShopERP Pro — Local Server
cd /d "%~dp0\server"

echo.
echo   ShopERP Pro — Local WiFi Server
echo   ─────────────────────────────────

:: Install better-sqlite3 if missing
if not exist "node_modules\better-sqlite3" (
  echo   Installing packages (first time only, takes ~1 min)...
  npm install --save better-sqlite3
  echo   Packages installed.
)

echo.
echo   Starting server...
echo.

node local.js
pause
