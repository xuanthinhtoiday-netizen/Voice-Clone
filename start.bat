@echo off
title VOXFORGE STUDIO - Unlimited TTS & Voice Cloning
cd /d "%~dp0"

echo ========================================================
echo    VOXFORGE STUDIO - Unlimited Neural TTS & Voice Clone
echo ========================================================
echo.
echo [1/2] Khoi dong Backend + Frontend tai http://127.0.0.1:8000
echo [2/2] Dang mo trinh duyet...
echo.

start "" http://127.0.0.1:8000
".venv\Scripts\python.exe" -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
pause
