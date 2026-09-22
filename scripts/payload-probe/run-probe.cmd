@echo off
set "PAYLOAD_ROOT=%~dp0.."
"%PAYLOAD_ROOT%\runtime\python.exe" "%PAYLOAD_ROOT%\probe\acp_probe.py" "%PAYLOAD_ROOT%"
