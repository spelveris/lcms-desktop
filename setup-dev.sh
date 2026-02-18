#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -n "${LCMS_PYTHON_BOOTSTRAP:-}" ]; then
  BOOTSTRAP_PYTHON="$LCMS_PYTHON_BOOTSTRAP"
elif command -v python3 >/dev/null 2>&1; then
  BOOTSTRAP_PYTHON="python3"
else
  BOOTSTRAP_PYTHON="python"
fi

echo "Creating virtual environment in .venv using: $BOOTSTRAP_PYTHON"
"$BOOTSTRAP_PYTHON" -m venv .venv

echo "Installing desktop backend dependencies..."
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt

echo ""
echo "Setup complete."
echo "Start backend only: ./start-dev.sh"
echo "Start Electron app: LCMS_PYTHON=./.venv/bin/python npm start"
