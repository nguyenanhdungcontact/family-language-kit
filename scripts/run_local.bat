@echo off
rem Windows: run the daily update on this computer (new videos, phrases, words), then push to GitHub.
rem Double-click this file, or schedule it with Task Scheduler (setup guide, step 6).
rem Keys are read from .env.local in the project folder (never uploaded).
cd /d "%~dp0\.."
if not exist .venv ( py -3 -m venv .venv )
call .venv\Scripts\activate.bat
pip install -q --disable-pip-version-check -r scripts\requirements.txt
set PYTHONWARNINGS=ignore
python scripts\daily.py %*
