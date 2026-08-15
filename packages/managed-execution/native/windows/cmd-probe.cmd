@echo off
setlocal
echo started>"%~3"
echo cmd-ok>"%~1"
if errorlevel 1 (
  echo workspace-write-failed>>"%~3"
  exit /b 10
)
echo blocked>"%~2" 2>nul
if exist "%~2" (
  echo outside-write-succeeded>>"%~3"
  exit /b 2
)
if not exist "%~1" (
  echo workspace-output-missing>>"%~3"
  exit /b 3
)
echo passed>>"%~3"
exit /b 0
