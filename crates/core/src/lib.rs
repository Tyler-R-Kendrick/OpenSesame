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

#[cfg(test)]
mod pact {
    use super::*;

    #[test]
    fn property_connection_handles_are_never_secret_kind() {
        for label in ["demo", "github", "stripe"] {
            let h = AuthorityHandle::connection(OrganizationId::new(), None, label);
            assert_eq!(h.kind, AuthorityKind::Connection);
            assert_ne!(h.kind, AuthorityKind::Secret);
        }
    }

    #[test]
    fn adversarial_secret_kind_is_distinct() {
        assert_ne!(AuthorityKind::Connection, AuthorityKind::Secret);
    }

    #[test]
    fn chaos_many_orgs_keep_connection_kind() {
        let kinds: Vec<_> = (0..32)
            .map(|_| AuthorityHandle::connection(OrganizationId::new(), None, "x").kind)
            .collect();
        assert!(kinds.iter().all(|k| *k == AuthorityKind::Connection));
    }

    #[test]
    fn contract_wit_package_is_core() {
        assert_eq!(wit_contract::PACKAGE, "opensesame:core@1.0.0");
    }
}
