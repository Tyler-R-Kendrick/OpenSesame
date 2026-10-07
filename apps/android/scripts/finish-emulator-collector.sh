#!/usr/bin/env bash
# Stop only the existing identity-verified collector, while the emulator is alive.
# This never validates native app behavior or converts a child failure into success.
finish_emulator_collector() {
  local application_status="$1" collector_status=0
  if [[ -n "${EMULATOR_BOOT_EVIDENCE:-}" ]]; then
    timeout 20s python3 "$(dirname "${BASH_SOURCE[0]}")/../../../scripts/test/emulator-boot-diagnostics.py" \
      stop "$EMULATOR_BOOT_EVIDENCE" || collector_status=$?
  fi
  if [[ "$application_status" != 0 ]]; then
    return "$application_status"
  fi
  return "$collector_status"
}
