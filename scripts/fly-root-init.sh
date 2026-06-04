#!/bin/sh
# Runs as root before handing off to fly-start.sh as the node user.
# Fixes ownership of /data files that may have been reset to root by
# privileged operations such as `openclaw doctor --fix`.
set -e
STATE_DIR="${OPENCLAW_STATE_DIR:-/data}"
chown -R node:node "$STATE_DIR" 2>/dev/null || true
exec su node -s /bin/sh -c "exec /app/fly-start.sh"
