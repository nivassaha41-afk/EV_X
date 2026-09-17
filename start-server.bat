@echo off
:: EV Server Auto-Start Script
:: This script starts the EV server using PM2
:: Place a shortcut to this file in your Windows Startup folder

echo Starting EV Server...
cd /d "%~dp0"
pm2 start ecosystem.config.js --update-env
pm2 save --force
echo EV Server started successfully!
