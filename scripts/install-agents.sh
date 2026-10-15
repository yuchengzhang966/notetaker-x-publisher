#!/bin/sh
# Install or reload the LaunchAgents for the bridge and the service, with this clone's paths.
# Reloading the bridge makes Brave ask "allow debugging?" once.
set -e
REPO=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)
AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS" "$HOME/Library/Logs/notetaker-x-publisher"
for name in bridge server; do
  label="local.notetaker-x-publisher.$name"
  sed -e "s|__NODE__|$NODE|g" -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" \
    "$REPO/launchd/$name.plist" > "$AGENTS/$label.plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
  echo "loaded $label"
done
