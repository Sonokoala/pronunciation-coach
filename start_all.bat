@echo off
rem Practise every English presentation in the "decks" folder. Pick one from the menu at the top.
cd /d "%~dp0"
python server.py "decks"
pause
