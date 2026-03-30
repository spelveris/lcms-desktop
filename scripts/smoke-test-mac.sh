#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${LCMS_SMOKE_PORT:-18741}"
TIMEOUT_SECONDS="${LCMS_SMOKE_TIMEOUT:-90}"
ZIP_PATH=""
APP_PATH=""
WORK_DIR=""

usage() {
  cat <<'EOF'
Usage: scripts/smoke-test-mac.sh [--zip PATH | --app PATH] [--port PORT] [--timeout SECONDS] [--work-dir DIR]

Runs a local smoke test against the packaged macOS backend by polling /api/health.

Options:
  --zip PATH        Use a packaged mac zip artifact.
  --app PATH        Use an unpacked CATrupole.app bundle.
  --port PORT       Override the backend port. Default: 18741
  --timeout SEC     Seconds to wait for /api/health. Default: 90
  --work-dir DIR    Directory for extracted files and logs.
  -h, --help        Show this help text.
EOF
}

abspath() {
  local target="$1"
  if [[ -d "$target" ]]; then
    (cd "$target" && pwd)
  else
    (cd "$(dirname "$target")" && printf '%s/%s\n' "$(pwd)" "$(basename "$target")")
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zip)
      [[ $# -ge 2 ]] || { echo "Missing value for --zip" >&2; exit 2; }
      ZIP_PATH="$2"
      shift 2
      ;;
    --app)
      [[ $# -ge 2 ]] || { echo "Missing value for --app" >&2; exit 2; }
      APP_PATH="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || { echo "Missing value for --port" >&2; exit 2; }
      PORT="$2"
      shift 2
      ;;
    --timeout)
      [[ $# -ge 2 ]] || { echo "Missing value for --timeout" >&2; exit 2; }
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --work-dir)
      [[ $# -ge 2 ]] || { echo "Missing value for --work-dir" >&2; exit 2; }
      WORK_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -n "$ZIP_PATH" && -n "$APP_PATH" ]]; then
  echo "Use either --zip or --app, not both." >&2
  exit 2
fi

if [[ -z "$ZIP_PATH" && -z "$APP_PATH" ]]; then
  latest_zip="$(ls -t "$ROOT_DIR"/release/CATrupole-*-arm64-mac.zip 2>/dev/null | head -n1 || true)"
  if [[ -n "$latest_zip" ]]; then
    ZIP_PATH="$latest_zip"
  elif [[ -d "$ROOT_DIR/release/mac-arm64/CATrupole.app" ]]; then
    APP_PATH="$ROOT_DIR/release/mac-arm64/CATrupole.app"
  else
    echo "Could not find a packaged mac artifact in release/." >&2
    exit 1
  fi
fi

if [[ -z "$WORK_DIR" ]]; then
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/catrupole-smoke.XXXXXX")"
else
  mkdir -p "$WORK_DIR"
  WORK_DIR="$(abspath "$WORK_DIR")"
fi

SOURCE_LABEL=""
SEARCH_ROOT=""
BACKEND_LOG="$WORK_DIR/backend.log"
HEALTH_JSON="$WORK_DIR/health.json"

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
    wait "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -n "$ZIP_PATH" ]]; then
  ZIP_PATH="$(abspath "$ZIP_PATH")"
  [[ -f "$ZIP_PATH" ]] || { echo "Zip artifact not found: $ZIP_PATH" >&2; exit 1; }

  DMG_PATH="${ZIP_PATH%-mac.zip}.dmg"
  [[ -f "$DMG_PATH" ]] || { echo "Matching DMG artifact not found: $DMG_PATH" >&2; exit 1; }

  EXTRACT_DIR="$WORK_DIR/unpacked"
  rm -rf "$EXTRACT_DIR"
  mkdir -p "$EXTRACT_DIR"
  unzip -q "$ZIP_PATH" -d "$EXTRACT_DIR"

  SEARCH_ROOT="$EXTRACT_DIR"
  SOURCE_LABEL="$ZIP_PATH"
else
  APP_PATH="$(abspath "$APP_PATH")"
  [[ -d "$APP_PATH" ]] || { echo "App bundle not found: $APP_PATH" >&2; exit 1; }

  SEARCH_ROOT="$APP_PATH"
  SOURCE_LABEL="$APP_PATH"
fi

BACKEND_BIN="$(find "$SEARCH_ROOT" -type f -path '*/Contents/Resources/backend/lcms-backend' | head -n1 || true)"
if [[ -z "$BACKEND_BIN" ]]; then
  echo "Could not find packaged backend binary under: $SEARCH_ROOT" >&2
  exit 1
fi

echo "Smoke source: $SOURCE_LABEL"
echo "Work dir: $WORK_DIR"
echo "Backend binary: $BACKEND_BIN"
echo "Port: $PORT"

LCMS_PORT="$PORT" "$BACKEND_BIN" >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

ok=0
for ((i = 1; i <= TIMEOUT_SECONDS; i++)); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >"$HEALTH_JSON" 2>/dev/null; then
    if python3 - "$HEALTH_JSON" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)

if payload.get("status") != "ok":
    raise SystemExit(1)
PY
    then
      ok=1
      break
    fi
  fi

  if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if [[ "$ok" -ne 1 ]]; then
  echo "Smoke test failed: packaged backend did not answer /api/health" >&2
  echo "Backend process running? $(kill -0 "$BACKEND_PID" >/dev/null 2>&1 && echo yes || echo no)" >&2
  echo "Backend log:" >&2
  cat "$BACKEND_LOG" >&2 || true
  exit 1
fi

echo "Health response:"
cat "$HEALTH_JSON"
