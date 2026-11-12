#!/bin/bash
# macOS: run the daily update automatically every morning (launchd).
# If the Mac is asleep at that time, macOS runs it as soon as the Mac wakes up.
#
#   ./scripts/install_daily_mac.sh            install (runs at 6:30 every day)
#   ./scripts/install_daily_mac.sh 21:15      install, run at 21:15
#   ./scripts/install_daily_mac.sh --remove   remove the schedule
#   Log:  ~/Library/Logs/family-language-kit.log
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.familylanguagekit.daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/family-language-kit.log"

if [ "$1" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "The daily schedule is removed."
  exit 0
fi

if [ ! -f "$REPO/.env.local" ]; then
  echo "There is no .env.local yet. Create the file $REPO/.env.local containing:"
  echo "  GEMINI_API_KEY=..."
  echo "  YOUTUBE_API_KEY=..."
  echo "then run this command again."
  exit 1
fi
chmod 600 "$REPO/.env.local"

TIME="${1:-06:30}"
HOUR=$((10#${TIME%%:*})); MIN=$((10#${TIME##*:}))

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$REPO/scripts/run_local.sh</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MIN</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLISTEOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
printf "Installed: runs at %02d:%02d every day.\nLog: %s\nTry it right now: launchctl kickstart gui/%s/%s\n" "$HOUR" "$MIN" "$LOG" "$(id -u)" "$LABEL"
