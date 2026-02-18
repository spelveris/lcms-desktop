#!/bin/bash
# Quick dev startup: runs backend only (open frontend/index.html in browser)
# For full Electron experience: npm start

cd "$(dirname "$0")"

if [ -n "${LCMS_PYTHON:-}" ]; then
  PYTHON_BIN="$LCMS_PYTHON"
elif [ -x "./.venv/bin/python" ]; then
  PYTHON_BIN="./.venv/bin/python"
elif [ -x "./backend/.venv/bin/python" ]; then
  PYTHON_BIN="./backend/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
else
  PYTHON_BIN="python"
fi

echo "=== LC-MS Desktop Dev Mode ==="
echo ""
echo "Starting FastAPI backend on http://localhost:8741 ..."
echo "Open frontend/index.html in your browser to use the app."
echo "Or run 'npm start' for the full Electron experience."
echo "Using Python: $PYTHON_BIN"
echo ""
echo "Press Ctrl+C to stop."
echo ""

"$PYTHON_BIN" backend/server.py
