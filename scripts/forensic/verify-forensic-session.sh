#!/usr/bin/env bash
set -u -o pipefail

usage() {
  echo "usage: verify-forensic-session.sh <session-dir> --evidence-root <root>" >&2
}

if [[ $# -ne 3 || "$2" != "--evidence-root" ]]; then
  usage
  exit 2
fi

session_dir=$1
evidence_root=$3
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
python_command=${PYTHON_COMMAND:-python3}

exec "$python_command" "$script_dir/forensic_validate.py" evidence \
  "$session_dir" --evidence-root "$evidence_root"
