#!/bin/sh
# Runs as root before handing off to fly-start.sh as the node user.
# Fixes ownership of /data files that may have been reset to root by
# privileged operations such as `openclaw doctor --fix`.
set -e
STATE_DIR="${OPENCLAW_STATE_DIR:-/data}"
chown -R node:node "$STATE_DIR" 2>/dev/null || true
# Prefer a start script on the persistent volume so fly ssh sftp + restart can
# update startup behavior without an image deploy. Delete /data/fly-start.sh
# after a successful image deploy or it will shadow the image's copy forever.
START_SCRIPT="/app/fly-start.sh"
if [ -f "$STATE_DIR/fly-start.sh" ]; then
  echo "fly-root-init: using override $STATE_DIR/fly-start.sh (delete it to use the image copy)"
  START_SCRIPT="$STATE_DIR/fly-start.sh"
fi
exec su node -s /bin/sh -c "exec /bin/sh $START_SCRIPT"
