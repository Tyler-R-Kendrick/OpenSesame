//! Duress deny ceilings at Host authority boundaries.
//!
//! Browser-local duress never requires this module (INV-01 / ADR 0130). When an
//! independent-authority hold is enrolled and active on Host, these ceilings
//! refuse authorize / mint / renew / invoke / sign / key-release for the bound
//! scope. Work that already left the Host is reported as
//! [`CeilingVerdict::AlreadyDispatched`] — never rewritten as a fresh deny.

mod ceiling_core;

#[cfg(test)]
mod ceiling_tests;

pub use ceiling_core::*;
