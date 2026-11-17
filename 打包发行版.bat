@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  Build release package (single .7z)
echo ============================================
echo.
node _pack.js
if errorlevel 1 (
  echo.
  echo BUILD FAILED
) else (
  echo.
  echo BUILD OK - see dist\
)
echo.
pause
