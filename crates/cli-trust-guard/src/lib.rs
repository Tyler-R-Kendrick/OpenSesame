//! Root-owned CLI root-trust seal helper (D7-2 mitigation a).

pub mod client;
pub mod protocol;
pub mod server;
pub mod storage;

pub use client::{guard_required, open_via_guard, seal_via_guard, socket_path_from_env, GuardError, GuardOpen};
pub use protocol::DEFAULT_SOCKET_PATH;

#[cfg(test)]
pub mod test_support;

#[cfg(test)]
#[path = "guard_tests.rs"]
mod guard_tests;
