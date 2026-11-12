@echo off
REM ============================================
REM  Life Cockpit - graceful stop (P0-7)
REM  NEVER use taskkill /F: it kills the process before the
REM  200ms debounced saveDb() timer fires, losing recent writes.
REM ============================================
setlocal
cd /d "%~dp0"
if defined PORT ( set "PORT_NUM=%PORT%" ) else ( set "PORT_NUM=15808" )
set "TOKEN_FILE=data\.stop-token"

if not exist "%TOKEN_FILE%" (
    echo [!] No stop token at %TOKEN_FILE%.
    echo     Service may be stopped, or started by an older version.
    echo     Press Ctrl+C in the service window instead - that also flushes data.
    goto WAIT
)

echo [*] Sending graceful stop request to 127.0.0.1:%PORT_NUM% ...
node -e "const fs=require('fs'),http=require('http');let t='';try{t=fs.readFileSync(process.argv[1],'utf8').trim()}catch(e){console.log('[!] Cannot read stop token: '+e.message);process.exit(1)}const r=http.request({host:'127.0.0.1',port:Number(process.argv[2]),path:'/__lc_shutdown',method:'POST',headers:{'X-LC-Stop-Token':t}},res=>{let s='';res.on('data',d=>s+=d);res.on('end',()=>{console.log('[*] '+s);process.exit(res.statusCode===200?0:1)})});r.on('error',e=>{console.log('[!] '+e.message);process.exit(1)});r.end();" "%TOKEN_FILE%" "%PORT_NUM%"

:WAIT
REM Wait up to 15s for the port to be released. No forced kill.
set /a N=0
:POLL
netstat -ano 2>nul | findstr "LISTENING" | findstr ":%PORT_NUM% " >nul 2>nul
if errorlevel 1 goto DONE
set /a N+=1
if %N% GEQ 15 goto STILL
timeout /t 1 /nobreak >nul
goto POLL

:DONE
echo [OK] Service stopped. Data was flushed to disk before exit.
exit /b 0

:STILL
echo [!] Port %PORT_NUM% is still listening after 15s.
echo     Do NOT force-kill: it bypasses the debounced save window.
echo     Check the service window / logs, then run this script again.
exit /b 1
