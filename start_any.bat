@echo off
rem Drag and drop a .pptx (slide text or speaker notes) or a .txt transcript (e.g. Whisper output) onto this file to practise it.
cd /d "%~dp0"
if "%~1"=="" (
  echo Drag a .pptx or .txt file onto start_any.bat to practise it.
  pause
  exit /b
)
python server.py "%~1"
pause
