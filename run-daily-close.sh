#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export NODE_ENV=${NODE_ENV:-production}

node "$ROOT_DIR/workers/dailyCloseWorker.js" "$@"
