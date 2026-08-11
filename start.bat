@echo off
REM worldsmith 一键启动 (Windows)
REM 双击此文件即可启动前后端 + 打开浏览器
cd /d "%~dp0"
node scripts/start.mjs
pause
