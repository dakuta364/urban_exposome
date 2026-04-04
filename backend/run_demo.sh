#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

pip install --upgrade pip
pip install -r requirements.txt

export DEMO_MODE="${DEMO_MODE:-true}"
export ENABLE_OSM_LOOKUP="${ENABLE_OSM_LOOKUP:-false}"
export ENABLE_LLM="${ENABLE_LLM:-true}"

uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}" --reload
