#!/bin/bash
# macOS / Linux: run the daily update on this computer (new videos, phrases, words), then push to GitHub.
#   By hand:        ./scripts/run_local.sh
#   Every morning:  ./scripts/install_daily_mac.sh   (macOS, see that file)
#
# Why on a home computer? YouTube usually refuses to hand subtitles to cloud servers (GitHub Actions),
# but it is happy to give them to a home internet connection.
#
# Keys are read from .env.local (listed in .gitignore, never uploaded):
#   GEMINI_API_KEY=...
#   YOUTUBE_API_KEY=...
set -e
cd "$(dirname "$0")/.."
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
if [ ! -d .venv ]; then
  echo "Setting up Python the first time..."
  python3 -m venv .venv
fi
source .venv/bin/activate
pip install -q --disable-pip-version-check -r scripts/requirements.txt 2>/dev/null
export PYTHONWARNINGS=ignore
python scripts/daily.py "$@"
