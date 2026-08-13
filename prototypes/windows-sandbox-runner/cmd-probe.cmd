@echo off
setlocal
echo cmd-ok>"%~1"
echo blocked>"%~2" 2>nul
if exist "%~2" exit /b 2
if not exist "%~1" exit /b 3
exit /b 0
