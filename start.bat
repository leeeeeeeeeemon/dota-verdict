@echo off
rem Запуск сервера «КТО ЗАРУНИЛ?» — http://127.0.0.1:8765
rem Сервер заодно кэширует и проксирует OpenDota API.
cd /d %~dp0
echo Server: http://127.0.0.1:8765  (zakroy okno, chtoby ostanovit)
start "" http://127.0.0.1:8765
python serve.py 8765
