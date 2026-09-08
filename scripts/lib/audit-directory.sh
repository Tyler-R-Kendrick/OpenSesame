#!/usr/bin/env bash
# Source after ROOT is set. Never cleans up or reuses a previous report path.
opensesame_audit_directory() {
  local base canonical root_canonical
  umask 077
  base="${OPENSESAME_AUDIT_DIR:-${TMPDIR:-/tmp}}"
  [[ "$base" == /* && "$base" != *$'\n'* && "$base" != *$'\r'* ]] || {
    echo "audit directory must be an absolute local path" >&2; return 1;
  }
  canonical="$(realpath -m -- "$base")" || return 1
  root_canonical="$(realpath -- "$ROOT")" || return 1
  [[ "$canonical" != "$root_canonical" && "$canonical" != "$root_canonical/"* ]] || {
    echo "audit directory must be outside the checkout" >&2; return 1;
  }
  [[ ! -L "$base" && "$base" == "$canonical" ]] || {
    echo "audit directory must be canonical and not a symlink" >&2; return 1;
  }
  if [[ -n "${OPENSESAME_AUDIT_DIR:-}" ]]; then
    if [[ ! -e "$base" ]]; then mkdir -m 700 -- "$base" || return 1; fi
    [[ -d "$base" && "$(stat -c %u -- "$base")" == "$(id -u)" && "$(stat -c %a -- "$base")" == 700 ]] || {
      echo "explicit audit directory must be owned by this user with mode 0700" >&2; return 1;
    }
  fi
  OPENSESAME_AUDIT_DIR="$(mktemp -d "$base/opensesame-audit.XXXXXXXX")" || return 1
  export OPENSESAME_AUDIT_DIR
  printf 'Private audit artifacts: %s\n' "$OPENSESAME_AUDIT_DIR" >&2
}
