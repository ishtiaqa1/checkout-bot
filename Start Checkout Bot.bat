@echo off
title Target Checkout Bot
cd /d "%~dp0"

if not exist "node_modules\" (
  echo First-time setup: installing dependencies...
  call npm install
  call npx playwright install chromium
)

echo.
echo Starting the Checkout Bot dashboard...
echo Your browser will open automatically. Keep this window open while using the app.
echo Close this window to stop the bot.
echo.

node src/index.js ui

pause
