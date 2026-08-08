@echo off
echo ================================
echo  LUX CLAN SERVER - Editor
echo ================================
echo.

:: Ir a la carpeta donde esta este .bat (LUX CLAN)
cd /d "%~dp0"

echo Carpeta activa: %CD%
echo.

:: Matar cualquier proceso Python corriendo en puerto 8091
echo Cerrando servidor anterior si existe...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":8091 "') do (
    taskkill /PID %%a /F >nul 2>&1
)

:: Esperar 1 segundo
timeout /t 1 /nobreak > nul

:: Iniciar servidor desde ESTA carpeta (LUX CLAN) en puerto 8091
echo Iniciando servidor LUX CLAN en puerto 8091...
start "" /B python -m http.server 8091

:: Esperar 2 segundos para que el servidor levante
timeout /t 2 /nobreak > nul

:: Abrir el navegador
start "" "http://localhost:8091/LUX_CLAN_EDITOR_BY.DAVID.XIT.html?hub=4"

echo.
echo Servidor corriendo en: http://localhost:8091
echo Carpeta servida: %CD%
echo.
echo Presiona cualquier tecla para detener el servidor.
echo.

pause > nul

:: Al cerrar, matar el servidor
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":8091 "') do (
    taskkill /PID %%a /F >nul 2>&1
)
echo Servidor LUX CLAN detenido.
