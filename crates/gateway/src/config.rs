//! Relay-only process args (ADR 0181). The Host API profile is gone.
use clap::Parser;
use std::net::SocketAddr;

pub use opensesame_host_core::deployment_mode::{Deployment, ExposureClass};

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    use sha2::{Digest, Sha256};
    let ha = Sha256::digest(a.as_bytes());
    let hb = Sha256::digest(b.as_bytes());
    ha.iter().zip(hb.iter()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

#[derive(Parser, Debug, Clone)]
#[command(name = "opensesame-relay")]
pub struct Args {
    #[arg(
        long,
        env = opensesame_host_core::endpoints::listen_env(opensesame_host_core::endpoints::HOST),
        default_value = "127.0.0.1:8787"
    )]
    pub listen: SocketAddr,
}

pub fn is_production_env() -> bool {
    opensesame_host_core::deployment_mode::from_env(ExposureClass::LocalOnly)
        .map_or(true, Deployment::production_safeguards)
}

pub fn cors_origins() -> Vec<String> {
    opensesame_host_core::http_security::cors_origins_from_env()
}

pub fn assert_cors_origins() -> Result<(), String> {
    opensesame_host_core::http_security::assert_cors_origins_allowed(
        &cors_origins(),
        is_production_env(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_strings_match() {
        assert!(constant_time_eq("slot-key", "slot-key"));
        assert!(!constant_time_eq("a", "b"));
    }
}
