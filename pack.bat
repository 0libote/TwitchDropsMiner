@echo off
rem Package the one-dir PyInstaller output (build.spec app_name) for distribution.
set APP_NAME=Twitch Drops Miner Next
set STAGE=%APP_NAME%
IF NOT EXIST 7z.exe GOTO NO7Z
IF NOT EXIST "dist\%APP_NAME%" (
    echo Build output "dist\%APP_NAME%" not found. Run build.bat first.
    GOTO EXIT
)
IF EXIST "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%"
rem Copy the built application folder and distribution documents
xcopy /e /i /y /q "dist\%APP_NAME%" "%STAGE%\%APP_NAME%"
copy /y /v manual.txt "%STAGE%"
copy /y /v LICENSE "%STAGE%"
copy /y /v NOTICE.md "%STAGE%"
IF EXIST "%APP_NAME%.zip" (
    rem Add action
    set action=a
) ELSE (
    rem Update action
    set action=u
)
rem Pack and test
7z %action% "%APP_NAME%.zip" "%STAGE%/" -r
7z t "%APP_NAME%.zip" * -r
rem Cleanup
IF EXIST "%STAGE%" rmdir /s /q "%STAGE%"
GOTO EXIT
:NO7Z
echo No 7z.exe detected, skipping packaging!
GOTO EXIT
:EXIT
exit %errorlevel%
