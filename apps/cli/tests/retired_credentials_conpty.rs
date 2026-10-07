//! Real Windows terminal management, separate from core-fixture admission tests.
#![cfg(windows)]
#[path = "windows_conpty/mod.rs"]
mod conpty;
#[path = "windows_conpty/journey.rs"]
mod journey;
#[path = "windows_conpty/lifecycle.rs"]
mod lifecycle;
#[path = "windows_conpty/refusals.rs"]
mod refusals;

#[path = "windows_conpty/canary.rs"]
mod canary;

#[test]
fn windows_terminal_enrollment_management_and_real_recovery() {
    conpty::mode_probe();
    lifecycle::run();
}

#[test]
fn windows_terminal_wrong_owner_collision_and_interrupt_preserve_records() {
    refusals::run();
}

#[test]
fn windows_terminal_canary_owner_export_installed_validator_and_clear_remove() {
    canary::run();
}
