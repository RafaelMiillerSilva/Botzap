@echo off
title Botzap - ZapBot
set "PATH=C:\Program Files\nodejs;%PATH%"
echo ============================================================
echo  Iniciando o Botzap...
echo ============================================================
node --dns-result-order=ipv4first --watch src/index.js
pause
