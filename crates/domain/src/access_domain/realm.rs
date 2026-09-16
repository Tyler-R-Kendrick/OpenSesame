//! The realm: the org/project boundary an access-domain forest is bound to.

use crate::{DomainError, OrganizationId, ProjectId};
use serde::{Deserialize, Serialize};

/// What kind of project a realm sits in (ADR 0038).
///
/// The kind is not decoration: it decides whether the realm may be shared at
/// all, and whether the project itself is on a clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectKind {
    /// Auto-provisioned default, one per principal. Never shareable, never
    /// deletable — and so never a place a second principal takes control.
    Personal,
    /// User-created, optionally shared through memberships.
    Standard,
    /// TTL-bound, minted through the claims flow.
    Temporary,
}

impl ProjectKind {
    /// Whether a second principal may ever hold authority in this project.
    ///
    /// `false` for [`ProjectKind::Personal`] — ADR 0038 refuses membership on
    /// personal projects outright, and a nested domain is not a loophole.
    #[must_use]
    pub fn admits_sharing(self) -> bool {
        !matches!(self, Self::Personal)
    }

    /// Whether the project itself has a deadline, in which case nothing inside
    /// it may be modelled as permanent.
    #[must_use]
    pub fn is_time_bound(self) -> bool {
        matches!(self, Self::Temporary)
    }
}

/// The boundary a forest lives inside: one project, under an optional
/// organization, of a known kind.
///
/// `Copy` on purpose. A realm is three identifiers; passing it by value
/// everywhere keeps it obvious that it is a *fact about a project* rather than
/// mutable state some caller can edit under a forest's feet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Realm {
    /// The organization above the project, when there is one. ADR 0038 keeps
    /// organizations an optional tier; nothing requires one.
    pub organization_id: Option<OrganizationId>,
    pub project_id: ProjectId,
    pub project_kind: ProjectKind,
}

impl Realm {
    /// A personal realm — one principal's own estate.
    #[must_use]
    pub fn personal(project_id: ProjectId) -> Self {
        Self {
            organization_id: None,
            project_id,
            project_kind: ProjectKind::Personal,
        }
    }

    /// A standard realm, optionally under an organization.
    #[must_use]
    pub fn standard(organization_id: Option<OrganizationId>, project_id: ProjectId) -> Self {
        Self {
            organization_id,
            project_id,
            project_kind: ProjectKind::Standard,
        }
    }

    /// A temporary realm, minted by the claims flow.
    #[must_use]
    pub fn temporary(organization_id: Option<OrganizationId>, project_id: ProjectId) -> Self {
        Self {
            organization_id,
            project_id,
            project_kind: ProjectKind::Temporary,
        }
    }

    /// The identifying pair. Two realms are the same boundary when this
    /// matches; the kind is a property of that same project, not a second
    /// dimension to compare on.
    #[must_use]
    pub fn boundary(&self) -> (Option<OrganizationId>, ProjectId) {
        (self.organization_id, self.project_id)
    }

    /// Whether `other` names the same org/project boundary.
    #[must_use]
    pub fn is_same_boundary(&self, other: &Self) -> bool {
        self.boundary() == other.boundary()
    }

    /// Refuse anything from another realm.
    ///
    /// This is the check that makes cross-realm reparenting unreachable rather
    /// than merely discouraged: a forest calls it on every node that tries to
    /// enter, so a domain can only ever be a child of a domain in its own
    /// project.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainRealmMismatch`] when the org/project pair
    /// differs, and also when the pair matches but the kind does not — the same
    /// project cannot be personal in one reading and standard in another, so
    /// that combination is corrupt input rather than a boundary crossing.
    pub fn assert_same_boundary(&self, other: &Self) -> Result<(), DomainError> {
        if !self.is_same_boundary(other) {
            return Err(DomainError::AccessDomainRealmMismatch(format!(
                "expected {}, got {}",
                self.project_id, other.project_id
            )));
        }
        if self.project_kind != other.project_kind {
            return Err(DomainError::AccessDomainRealmMismatch(format!(
                "project {} disagrees on kind: {:?} vs {:?}",
                self.project_id, self.project_kind, other.project_kind
            )));
        }
        Ok(())
    }

    /// Whether this realm may ever hold authority for a second principal.
    #[must_use]
    pub fn admits_sharing(&self) -> bool {
        self.project_kind.admits_sharing()
    }

    /// Refuse a sharing operation in a realm that does not share.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainPersonalSharing`] in a personal realm.
    pub fn assert_admits_sharing(&self, what: &str) -> Result<(), DomainError> {
        if self.admits_sharing() {
            return Ok(());
        }
        Err(DomainError::AccessDomainPersonalSharing(format!(
            "{what} in personal project {}",
            self.project_id
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn personal_realm_never_shares() {
        let realm = Realm::personal(ProjectId::new());
        assert!(!realm.admits_sharing());
        assert!(realm.assert_admits_sharing("second member").is_err());
    }

    #[test]
    fn standard_and_temporary_realms_share() {
        let project = ProjectId::new();
        assert!(Realm::standard(None, project).admits_sharing());
        assert!(Realm::temporary(None, project).admits_sharing());
    }

    #[test]
    fn different_projects_are_different_boundaries() {
        let a = Realm::standard(None, ProjectId::new());
        let b = Realm::standard(None, ProjectId::new());
        assert!(!a.is_same_boundary(&b));
        assert!(a.assert_same_boundary(&b).is_err());
    }

    #[test]
    fn same_project_under_a_different_org_is_a_different_boundary() {
        let project = ProjectId::new();
        let a = Realm::standard(Some(OrganizationId::new()), project);
        let b = Realm::standard(Some(OrganizationId::new()), project);
        assert!(a.assert_same_boundary(&b).is_err());
    }

    #[test]
    fn same_project_disagreeing_on_kind_is_refused() {
        let project = ProjectId::new();
        let personal = Realm::personal(project);
        let standard = Realm::standard(None, project);
        assert!(personal.is_same_boundary(&standard));
        assert!(personal.assert_same_boundary(&standard).is_err());
    }

    #[test]
    fn temporary_projects_are_time_bound() {
        assert!(ProjectKind::Temporary.is_time_bound());
        assert!(!ProjectKind::Standard.is_time_bound());
        assert!(!ProjectKind::Personal.is_time_bound());
    }

    /// INV-GA-04 / ADR 0038: the hierarchy terminates at a project. An
    /// organization is an optional tier above it, never a required parent.
    #[test]
    fn a_hierarchy_terminates_at_a_project_without_an_organization() {
        let project = ProjectId::new();
        let personal = Realm::personal(project);
        let standard = Realm::standard(None, project);
        let temporary = Realm::temporary(None, project);

        assert_eq!(personal.organization_id, None);
        assert_eq!(standard.organization_id, None);
        assert_eq!(temporary.organization_id, None);
        assert_eq!(personal.project_id, project);
        assert_eq!(standard.project_id, project);
        assert_eq!(temporary.project_id, project);

        let under_org = Realm::standard(Some(OrganizationId::new()), project);
        assert!(under_org.organization_id.is_some());
        assert_eq!(under_org.project_id, project);
        assert!(
            !under_org.is_same_boundary(&standard),
            "an optional org is a different boundary, not a required parent of the same one"
        );
    }
}
