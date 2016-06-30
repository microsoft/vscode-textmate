@echo off
setlocal

set ATOM_SHELL_INTERNAL_RUN_AS_NODE=1

pushd %~dp0\..
..\vscode\.build\electron\electron.exe .\scripts\tests.js
popd

endlocal
exit /b %errorlevel%