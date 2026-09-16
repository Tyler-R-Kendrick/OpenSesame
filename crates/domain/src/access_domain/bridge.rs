//! Bridges onto the authority primitives that already exist.
//!
//! An access domain is a new *place*, not a new authority model. Everything in
//! this file is a seam onto something already decided:
//!
//! - [`VaultBinding`] carries ADR 0038's project crypto binding, so a domain
//!   that names a vault names the same `project_id` `crates/human-vault` seals
//!   into the envelope's AEAD associated data.
//! - [`handle_in_realm`] checks an [`AuthorityHandle`] against a realm, so a
//!   domain cannot come to hold a connection from another project.
//! - [`DomainRole`] is the same three-rung ladder as [`OrganizationRole`] and
//!   ADR 0038's project roles, with conversions rather than a parallel
//!   vocabulary.
//! - The `*_WIRE` tables freeze the serialized strings. The TypeScript plane
//!   mirrors them in `packages/os-domain/src/access-domain/bridge.ts`, and the
//!   tests at the bottom of this file are what stop the two planes drifting.

use super::control::DomainRole;
use super::realm::Realm;
use crate::{AuthorityHandle, DomainError, OrganizationRole, ProjectId, VaultId};
use serde::{Deserialize, Serialize};

/// Frozen serialized names for [`DomainRole`], weakest rung first.
pub const DOMAIN_ROLE_WIRE: [&str; 3] = ["member", "admin", "owner"];
/// Frozen serialized names for [`super::control::ControlScope`].
pub const DOMAIN_SCOPE_WIRE: [&str; 2] = ["domain_only", "subtree"];
/// Frozen serialized names for [`super::control::InheritanceMode`].
pub const DOMAIN_INHERITANCE_WIRE: [&str; 2] = ["inherit", "isolated"];
/// Frozen serialized names for [`super::temporal::DomainLifetime`]'s
/// discriminant.
pub const DOMAIN_LIFETIME_WIRE: [&str; 2] = ["permanent", "temporary"];
/// Frozen serialized names for [`super::realm::ProjectKind`].
pub const DOMAIN_PROJECT_KIND_WIRE: [&str; 3] = ["personal", "standard", "temporary"];

/// A domain's link to a vault, carrying the project the vault's envelopes are
/// sealed against.
///
/// The `project_id` is not a convenience copy. `crates/human-vault` binds it
/// into every envelope's associated data (ADR 0038), so it is part of the
/// ciphertext's identity: a binding whose project disagrees with the realm
/// names a vault this domain could not open. [`VaultBinding::bind`] is the only
/// constructor and takes the project from the realm, so the disagreement cannot
/// be introduced by a caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultBinding {
    pub vault_id: VaultId,
    pub project_id: ProjectId,
}

impl VaultBinding {
    /// Bind a vault to a domain in `realm`.
    #[must_use]
    pub fn bind(realm: &Realm, vault_id: VaultId) -> Self {
        Self {
            vault_id,
            project_id: realm.project_id,
        }
    }

    /// Re-check the binding against a realm.
    ///
    /// Called on every insert rather than only at construction: a binding that
    /// arrived over the wire, or out of storage, has not passed through
    /// [`VaultBinding::bind`].
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainVaultBinding`] when the bound project is not
    /// the realm's — the case that would hand a domain a vault whose AEAD
    /// associated data it cannot reproduce.
    pub fn assert_matches_realm(&self, realm: &Realm) -> Result<(), DomainError> {
        if self.project_id == realm.project_id {
            return Ok(());
        }
        Err(DomainError::AccessDomainVaultBinding(format!(
            "vault {} is sealed against {}, realm is {}",
            self.vault_id, self.project_id, realm.project_id
        )))
    }
}

/// Whether an authority handle belongs to this realm.
///
/// A handle that names no project is org-wide. That is a legitimate handle, but
/// it is not a domain-scoped one: placing it in a domain would let a subtree
/// grant reach every project in the organization, so it is refused here rather
/// than narrowed silently.
#[must_use]
pub fn handle_in_realm(handle: &AuthorityHandle, realm: &Realm) -> bool {
    if realm.organization_id != Some(handle.organization_id) {
        return false;
    }
    handle.project_id == Some(realm.project_id)
}

/// Refuse a handle from outside the realm.
///
/// # Errors
///
/// [`DomainError::AccessDomainRealmMismatch`] when the handle's organization or
/// project is not the realm's, including when the handle names no project.
pub fn assert_handle_in_realm(handle: &AuthorityHandle, realm: &Realm) -> Result<(), DomainError> {
    if handle_in_realm(handle, realm) {
        return Ok(());
    }
    Err(DomainError::AccessDomainRealmMismatch(format!(
        "handle {} is not in project {}",
        handle.uri(),
        realm.project_id
    )))
}

impl DomainRole {
    /// The domain rung an organization membership already carries.
    #[must_use]
    pub fn from_organization_role(role: OrganizationRole) -> Self {
        match role {
            OrganizationRole::Owner => Self::Owner,
            OrganizationRole::Admin => Self::Admin,
            OrganizationRole::Member => Self::Member,
        }
    }

    /// The organization rung this domain role corresponds to, for surfaces that
    /// still speak memberships.
    #[must_use]
    pub fn to_organization_role(self) -> OrganizationRole {
        match self {
            Self::Owner => OrganizationRole::Owner,
            Self::Admin => OrganizationRole::Admin,
            Self::Member => OrganizationRole::Member,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::control::{ControlScope, InheritanceMode};
    use super::super::realm::ProjectKind;
    use super::*;
    use crate::access_domain::temporal::DomainLifetime;
    use crate::{AuthorityHandle, OrganizationId};
    use chrono::{DateTime, Utc};

    fn wire_of<T: Serialize>(value: &T) -> String {
        serde_json::to_value(value)
            .expect("serializable")
            .as_str()
            .expect("string-shaped enum")
            .to_string()
    }

    #[test]
    fn role_scope_and_inheritance_wire_names_are_frozen() {
        let roles = [DomainRole::Member, DomainRole::Admin, DomainRole::Owner];
        for (role, expected) in roles.iter().zip(DOMAIN_ROLE_WIRE) {
            assert_eq!(wire_of(role), expected);
        }
        let scopes = [ControlScope::DomainOnly, ControlScope::Subtree];
        for (scope, expected) in scopes.iter().zip(DOMAIN_SCOPE_WIRE) {
            assert_eq!(wire_of(scope), expected);
        }
        let modes = [InheritanceMode::Inherit, InheritanceMode::Isolated];
        for (mode, expected) in modes.iter().zip(DOMAIN_INHERITANCE_WIRE) {
            assert_eq!(wire_of(mode), expected);
        }
        let kinds = [
            ProjectKind::Personal,
            ProjectKind::Standard,
            ProjectKind::Temporary,
        ];
        for (kind, expected) in kinds.iter().zip(DOMAIN_PROJECT_KIND_WIRE) {
            assert_eq!(wire_of(kind), expected);
        }
    }

    #[test]
    fn lifetime_wire_tag_is_frozen() {
        let permanent = serde_json::to_value(DomainLifetime::Permanent).expect("serializable");
        assert_eq!(permanent["kind"], DOMAIN_LIFETIME_WIRE[0]);
        let temporary = serde_json::to_value(DomainLifetime::Temporary {
            expires_at: DateTime::<Utc>::from_timestamp(0, 0).expect("epoch"),
        })
        .expect("serializable");
        assert_eq!(temporary["kind"], DOMAIN_LIFETIME_WIRE[1]);
    }

    #[test]
    fn role_ladder_matches_organization_memberships() {
        for role in [
            OrganizationRole::Owner,
            OrganizationRole::Admin,
            OrganizationRole::Member,
        ] {
            let domain_role = DomainRole::from_organization_role(role);
            assert_eq!(domain_role.to_organization_role(), role);
            assert_eq!(
                domain_role.can_administer(),
                role.can_configure_integrations()
            );
        }
    }

    #[test]
    fn a_vault_binding_takes_its_project_from_the_realm() {
        let realm = Realm::standard(None, ProjectId::new());
        let binding = VaultBinding::bind(&realm, VaultId::new());
        assert_eq!(binding.project_id, realm.project_id);
        assert!(binding.assert_matches_realm(&realm).is_ok());
    }

    #[test]
    fn a_binding_from_another_project_is_refused() {
        let realm = Realm::standard(None, ProjectId::new());
        let elsewhere = Realm::standard(None, ProjectId::new());
        let binding = VaultBinding::bind(&elsewhere, VaultId::new());
        assert!(matches!(
            binding.assert_matches_realm(&realm),
            Err(DomainError::AccessDomainVaultBinding(_))
        ));
    }

    #[test]
    fn a_handle_must_name_both_the_org_and_the_project() {
        let org = OrganizationId::new();
        let project = ProjectId::new();
        let realm = Realm::standard(Some(org), project);
        let handle = AuthorityHandle {
            kind: crate::AuthorityKind::Connection,
            organization_id: org,
            project_id: Some(project),
            logical_name: "github/main".to_string(),
            version: None,
        };
        assert!(handle_in_realm(&handle, &realm));

        let org_wide = AuthorityHandle {
            project_id: None,
            ..handle.clone()
        };
        assert!(!handle_in_realm(&org_wide, &realm));
        assert!(assert_handle_in_realm(&org_wide, &realm).is_err());

        let other_project = AuthorityHandle {
            project_id: Some(ProjectId::new()),
            ..handle.clone()
        };
        assert!(assert_handle_in_realm(&other_project, &realm).is_err());

        let other_org = AuthorityHandle {
            organization_id: OrganizationId::new(),
            ..handle
        };
        assert!(assert_handle_in_realm(&other_org, &realm).is_err());
    }
}
