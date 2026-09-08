#!/usr/bin/env bash
# Public tracked seeds are read-only inputs; all fuzz growth stays private.
source "$ROOT/scripts/lib/audit-directory.sh"
opensesame_audit_directory
mkdir -p "$OPENSESAME_AUDIT_DIR/artifacts" "$OPENSESAME_AUDIT_DIR/corpus"

opensesame_fuzz_corpus() {
  local target="$1" seed destination
  [[ "$target" =~ ^[a-zA-Z0-9_-]+$ ]] || return 1
  corpus="$OPENSESAME_AUDIT_DIR/corpus/$target"
  mkdir -p "$corpus"
  git -C "$ROOT" ls-files -z -- "fuzz/corpus/$target/" "fuzz/regressions/$target/" +    > "$OPENSESAME_AUDIT_DIR/$target-seeds"
  while IFS= read -r -d '' seed; do
    [[ -f "$ROOT/$seed" && ! -L "$ROOT/$seed" ]] || continue
    destination="$corpus/$seed"
    mkdir -p "$(dirname "$destination")"
    cp -- "$ROOT/$seed" "$destination"
  done < "$OPENSESAME_AUDIT_DIR/$target-seeds"
}
