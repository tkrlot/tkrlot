@echo off
SETLOCAL ENABLEEXTENSIONS
:: ================================
:: Google Chrome Update Blocker
:: Must be run as Administrator
:: ================================

:: Check for admin rights
openfiles >nul 2>&1
if %errorlevel% NEQ 0 (
    echo.
    echo [ERROR] This script must be run as Administrator.
    echo        Right-click and choose "Run as administrator".
    pause
    exit /b
)

echo.
echo ================================
echo   Disabling Google Chrome Updates
echo ================================

:: Step 1: Stop Google Update services
echo [1/4] Stopping Google Update services...
sc stop gupdate >nul 2>&1
sc stop gupdatem >nul 2>&1

:: Step 2: Disable Google Update services
echo [2/4] Disabling Google Update services...
sc config gupdate start= disabled >nul 2>&1
sc config gupdatem start= disabled >nul 2>&1

:: Step 3: Rename Update folders
echo [3/4] Renaming Update folders if found...

set "UpdatePath1=%ProgramFiles(x86)%\Google\Update"
if exist "%UpdatePath1%" (
    ren "%UpdatePath1%" "Update_disabled" >nul 2>&1
    echo     Renamed: %UpdatePath1%
) else (
    echo     Not found: %UpdatePath1%
)

set "UpdatePath2=%LocalAppData%\Google\Update"
if exist "%UpdatePath2%" (
    ren "%UpdatePath2%" "Update_disabled" >nul 2>&1
    echo     Renamed: %UpdatePath2%
) else (
    echo     Not found: %UpdatePath2%
)

:: Step 4: Add registry keys to block updates
echo [4/4] Adding registry keys...

reg add "HKLM\SOFTWARE\Policies\Google" /f >nul
reg add "HKLM\SOFTWARE\Policies\Google\Update" /f >nul

reg add "HKLM\SOFTWARE\Policies\Google\Update" /v AutoUpdateCheckPeriodMinutes /t REG_DWORD /d 0 /f >nul
reg add "HKLM\SOFTWARE\Policies\Google\Update" /v UpdateDefault /t REG_DWORD /d 0 /f >nul
reg add "HKLM\SOFTWARE\Policies\Google\Update" /v DisableAutoUpdateChecksCheckboxValue /t REG_DWORD /d 1 /f >nul

echo.
echo ✅ Chrome auto-updates have been disabled.
echo 🔒 Please restart your computer to apply all changes.
pause
ENDLOCAL
