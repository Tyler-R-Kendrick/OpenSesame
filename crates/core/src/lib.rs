//! OpenSesame **core sdk** — shared IR with no I/O.
//!
//! WIT contracts: `wit/core/world.wit`.
//! Prefer this facade for new host/client dependents (ADR 0017).

pub use opensesame_domain::*;

/// Product-facing alias for the shared core surface (see `wit/core/world.wit`).
pub mod wit_contract {
    pub const PACKAGE: &str = "opensesame:core@1.0.0";
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_handle_is_not_secret() {
        let org = OrganizationId::new();
        let h = AuthorityHandle::connection(org, None, "demo");
        assert_eq!(h.kind, AuthorityKind::Connection);
        assert_ne!(h.kind, AuthorityKind::Secret);
    }
}
