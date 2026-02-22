#!/usr/bin/env bash
set -euo pipefail

SERVICE_LABEL="com.fanzhh.qq-onebot-bot"
PLIST="$HOME/Library/LaunchAgents/${SERVICE_LABEL}.plist"
LOG_FILE="/Users/mac/projects/qq-onebot-bot/logs/qq-onebot-bot.log"
ERR_FILE="/Users/mac/projects/qq-onebot-bot/logs/qq-onebot-bot-error.log"

cmd="${1:-status}"

case "$cmd" in
  status)
    launchctl list | grep "$SERVICE_LABEL" || true
    lsof -nP -iTCP:3002 -sTCP:LISTEN || true
    ;;
  logs)
    tail -n 80 "$LOG_FILE" 2>/dev/null || echo "No log file: $LOG_FILE"
    ;;
  error-logs)
    tail -n 80 "$ERR_FILE" 2>/dev/null || echo "No error log file: $ERR_FILE"
    ;;
  restart)
    launchctl unload "$PLIST" >/dev/null 2>&1 || true
    launchctl load "$PLIST"
    launchctl list | grep "$SERVICE_LABEL" || true
    ;;
  *)
    echo "Usage: $0 {status|logs|error-logs|restart}"
    exit 1
    ;;
esac
