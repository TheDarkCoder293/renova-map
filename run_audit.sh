#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$ROOT_DIR/scripts/audit_clinics.py"
FILE="$ROOT_DIR/clinics.geojson"

usage() {
  cat <<'EOF'
Usage:
  ./run_audit.sh                     # run the full audit and save the reports
  ./run_audit.sh --quick             # quicker check, no export files
  ./run_audit.sh --max-items 50      # same audit, just show more rows
  ./run_audit.sh --no-export         # print results only
  ./run_audit.sh --help
EOF
}

MAX_ITEMS=20
NO_EXPORT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick)
      NO_EXPORT=1
      MAX_ITEMS=20
      shift
      ;;
    --max-items)
      if [[ $# -lt 2 ]]; then
        echo "Error: --max-items requires a value"
        exit 2
      fi
      MAX_ITEMS="$2"
      shift 2
      ;;
    --no-export)
      NO_EXPORT=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument '$1'"
      usage
      exit 2
      ;;
  esac
done

if [[ ! -f "$SCRIPT" ]]; then
  echo "Error: missing script at $SCRIPT"
  exit 2
fi

if [[ ! -f "$FILE" ]]; then
  echo "Error: missing GeoJSON at $FILE"
  exit 2
fi

CMD=(python3 "$SCRIPT" --file "$FILE" --max-items "$MAX_ITEMS")
if [[ "$NO_EXPORT" -eq 1 ]]; then
  CMD+=(--no-export)
fi

echo "Running: ${CMD[*]}"
"${CMD[@]}"
