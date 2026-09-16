//! One access domain: its identity, its slug, and the fields a forest's
//! invariants depend on.
//!
//! The fields are private and reachable only through accessors. That is
//! deliberate: `realm`, `parent_id`, `slug` and `lifetime` are exactly the
//! values [`super::forest::AccessDomainForest`] validated on the way in, so
//! leaving them writable would let a caller edit a forest into a shape no
//! mutation would have accepted — a domain reparented across realms by
//! assignment, for instance. Changing any of them goes through
//! [`super::mutate`], which re-checks.

use super::bridge::VaultBinding;
use super::control::InheritanceMode;
use super::realm::Realm;
use super::temporal::DomainLifetime;
use crate::{AccessDomainId, DomainError};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// The longest a domain slug may be. Matches the DNS label limit, because a
/// domain path is the kind of thing that ends up in a URL, a filename, and an
/// operator's terminal.
pub const MAX_DOMAIN_SLUG_CHARS: usize = 63;

/// The longest a human-facing domain name may be. Long enough for a real team
/// name, short enough that a path stays readable on a phone.
pub const MAX_DOMAIN_DISPLAY_NAME_CHARS: usize = 128;

/// A node in a realm's access-domain forest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessDomain {
    id: AccessDomainId,
    realm: Realm,
    parent_id: Option<AccessDomainId>,
    slug: String,
    display_name: String,
    inheritance: InheritanceMode,
    lifetime: DomainLifetime,
    vault_binding: Option<VaultBinding>,
    created_at: DateTime<Utc>,
}

impl AccessDomain {
    /// A root domain: one of the realm's forest roots, with no parent.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainInvalid`] when the slug or display name is
    /// malformed.
    pub fn root(
        id: AccessDomainId,
        realm: Realm,
        slug: &str,
        display_name: &str,
        created_at: DateTime<Utc>,
    ) -> Result<Self, DomainError> {
        Self::build(id, realm, None, slug, display_name, created_at)
    }

    /// A child domain under `parent_id`.
    ///
    /// The parent is named but not checked here — a bare node knows nothing
    /// about the forest. Existence, depth, sibling uniqueness, and the lifetime
    /// and vault rules are the forest's, at insert.
    ///
    /// # Errors
    ///
    /// As [`AccessDomain::root`].
    pub fn child(
        id: AccessDomainId,
        realm: Realm,
        parent_id: AccessDomainId,
        slug: &str,
        display_name: &str,
        created_at: DateTime<Utc>,
    ) -> Result<Self, DomainError> {
        Self::build(id, realm, Some(parent_id), slug, display_name, created_at)
    }

    fn build(
        id: AccessDomainId,
        realm: Realm,
        parent_id: Option<AccessDomainId>,
        slug: &str,
        display_name: &str,
        created_at: DateTime<Utc>,
    ) -> Result<Self, DomainError> {
        assert_slug(slug)?;
        assert_display_name(display_name)?;
        Ok(Self {
            id,
            realm,
            parent_id,
            slug: slug.to_string(),
            display_name: display_name.to_string(),
            inheritance: InheritanceMode::Inherit,
            lifetime: DomainLifetime::Permanent,
            vault_binding: None,
            created_at,
        })
    }

    /// Break control inheritance at this domain, or restore it.
    #[must_use]
    pub fn with_inheritance(mut self, inheritance: InheritanceMode) -> Self {
        self.inheritance = inheritance;
        self
    }

    /// Put this domain on a clock.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainLifetime`] when the deadline is already past
    /// at creation or beyond the cap. Whether it also fits under the parent is
    /// the forest's check, because only the forest knows the parent.
    pub fn with_lifetime(mut self, lifetime: DomainLifetime) -> Result<Self, DomainError> {
        lifetime.assert_well_formed(self.created_at)?;
        self.lifetime = lifetime;
        Ok(self)
    }

    /// Bind a vault to this domain.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainVaultBinding`] when the binding's project is
    /// not this domain's realm — see [`VaultBinding`] for why that is fatal
    /// rather than correctable.
    pub fn with_vault_binding(mut self, binding: VaultBinding) -> Result<Self, DomainError> {
        binding.assert_matches_realm(&self.realm)?;
        self.vault_binding = Some(binding);
        Ok(self)
    }

    #[must_use]
    pub fn id(&self) -> AccessDomainId {
        self.id
    }

    #[must_use]
    pub fn realm(&self) -> Realm {
        self.realm
    }

    #[must_use]
    pub fn parent_id(&self) -> Option<AccessDomainId> {
        self.parent_id
    }

    #[must_use]
    pub fn is_root(&self) -> bool {
        self.parent_id.is_none()
    }

    #[must_use]
    pub fn slug(&self) -> &str {
        &self.slug
    }

    #[must_use]
    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    #[must_use]
    pub fn inheritance(&self) -> InheritanceMode {
        self.inheritance
    }

    #[must_use]
    pub fn lifetime(&self) -> DomainLifetime {
        self.lifetime
    }

    #[must_use]
    pub fn vault_binding(&self) -> Option<VaultBinding> {
        self.vault_binding
    }

    #[must_use]
    pub fn created_at(&self) -> DateTime<Utc> {
        self.created_at
    }

    /// Whether this domain is still live at the caller's clock reading.
    ///
    /// Answers only for this node. A live domain under an expired ancestor is
    /// unreachable, and `AccessDomainForest::assert_reachable` is the check
    /// that says so.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainExpired`] once the deadline has passed.
    pub fn assert_active(&self, now: DateTime<Utc>) -> Result<(), DomainError> {
        self.lifetime.assert_active(now)
    }

    pub(super) fn set_parent(&mut self, parent_id: Option<AccessDomainId>) {
        self.parent_id = parent_id;
    }

    pub(super) fn set_slug(&mut self, slug: String) {
        self.slug = slug;
    }

    pub(super) fn set_display_name(&mut self, display_name: String) {
        self.display_name = display_name;
    }

    pub(super) fn set_inheritance(&mut self, inheritance: InheritanceMode) {
        self.inheritance = inheritance;
    }

    pub(super) fn set_lifetime(&mut self, lifetime: DomainLifetime) {
        self.lifetime = lifetime;
    }
}

/// Slug rules: a lowercase DNS-ish label.
///
/// Narrow on purpose. A slug appears in a path, so anything that could be read
/// as path structure (`/`, `.`, `..`) or that differs only by case is refused
/// rather than normalized — two domains whose paths differ only in case are two
/// domains an operator cannot tell apart.
///
/// # Errors
///
/// [`DomainError::AccessDomainInvalid`] for an empty slug, one over
/// [`MAX_DOMAIN_SLUG_CHARS`], one with a character outside `[a-z0-9-]`, or one
/// starting or ending with a hyphen.
pub fn assert_slug(slug: &str) -> Result<(), DomainError> {
    if slug.is_empty() {
        return Err(DomainError::AccessDomainInvalid(
            "domain slug is empty".to_string(),
        ));
    }
    if slug.chars().count() > MAX_DOMAIN_SLUG_CHARS {
        return Err(DomainError::AccessDomainInvalid(format!(
            "domain slug exceeds {MAX_DOMAIN_SLUG_CHARS} characters"
        )));
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(DomainError::AccessDomainInvalid(format!(
            "domain slug {slug:?} is not lowercase [a-z0-9-]"
        )));
    }
    if slug.starts_with('-') || slug.ends_with('-') {
        return Err(DomainError::AccessDomainInvalid(format!(
            "domain slug {slug:?} starts or ends with a hyphen"
        )));
    }
    Ok(())
}

/// Display-name rules: present, bounded, single-line.
///
/// # Errors
///
/// [`DomainError::AccessDomainInvalid`] when blank, over
/// [`MAX_DOMAIN_DISPLAY_NAME_CHARS`], or carrying a control character — a name
/// with a newline in it can misrepresent a listing.
pub fn assert_display_name(display_name: &str) -> Result<(), DomainError> {
    if display_name.trim().is_empty() {
        return Err(DomainError::AccessDomainInvalid(
            "domain display name is blank".to_string(),
        ));
    }
    if display_name.chars().count() > MAX_DOMAIN_DISPLAY_NAME_CHARS {
        return Err(DomainError::AccessDomainInvalid(format!(
            "domain display name exceeds {MAX_DOMAIN_DISPLAY_NAME_CHARS} characters"
        )));
    }
    if display_name.chars().any(char::is_control) {
        return Err(DomainError::AccessDomainInvalid(
            "domain display name carries a control character".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ProjectId, VaultId};

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-03-01T00:00:00Z")
            .expect("fixture timestamp")
            .with_timezone(&Utc)
    }

    fn realm() -> Realm {
        Realm::standard(None, ProjectId::new())
    }

    #[test]
    fn a_root_has_no_parent_and_inherits_by_default() {
        let domain = AccessDomain::root(
            AccessDomainId::new(),
            realm(),
            "platform",
            "Platform",
            now(),
        )
        .expect("valid root");
        assert!(domain.is_root());
        assert_eq!(domain.parent_id(), None);
        assert_eq!(domain.inheritance(), InheritanceMode::Inherit);
        assert_eq!(domain.lifetime(), DomainLifetime::Permanent);
        assert_eq!(domain.vault_binding(), None);
    }

    #[test]
    fn slugs_refuse_path_structure_and_case() {
        for bad in [
            "",
            "Platform",
            "plat form",
            "plat/form",
            "..",
            "-platform",
            "platform-",
            "platform_prod",
            "plaeform\u{e4}",
        ] {
            assert!(assert_slug(bad).is_err(), "{bad:?} should be refused");
        }
        for good in ["platform", "prod-1", "a", "0"] {
            assert!(assert_slug(good).is_ok(), "{good:?} should be accepted");
        }
    }

    #[test]
    fn slug_length_is_bounded() {
        assert!(assert_slug(&"a".repeat(MAX_DOMAIN_SLUG_CHARS)).is_ok());
        assert!(assert_slug(&"a".repeat(MAX_DOMAIN_SLUG_CHARS + 1)).is_err());
    }

    #[test]
    fn display_names_refuse_blanks_and_control_characters() {
        assert!(assert_display_name("Platform").is_ok());
        assert!(assert_display_name("   ").is_err());
        assert!(assert_display_name("Plat\nform").is_err());
        assert!(assert_display_name(&"a".repeat(MAX_DOMAIN_DISPLAY_NAME_CHARS + 1)).is_err());
    }

    #[test]
    fn a_vault_binding_from_another_realm_is_refused_at_the_node() {
        let realm = realm();
        let elsewhere = Realm::standard(None, ProjectId::new());
        let domain =
            AccessDomain::root(AccessDomainId::new(), realm, "platform", "Platform", now())
                .expect("valid root");
        let foreign = VaultBinding::bind(&elsewhere, VaultId::new());
        assert!(domain.clone().with_vault_binding(foreign).is_err());
        let own = VaultBinding::bind(&realm, VaultId::new());
        assert!(domain.with_vault_binding(own).is_ok());
    }

    #[test]
    fn a_spent_lifetime_is_refused_at_construction() {
        let domain = AccessDomain::root(AccessDomainId::new(), realm(), "visit", "Visit", now())
            .expect("valid root");
        assert!(domain
            .clone()
            .with_lifetime(DomainLifetime::Temporary { expires_at: now() })
            .is_err());
        assert!(domain
            .with_lifetime(DomainLifetime::Temporary {
                expires_at: now() + chrono::Duration::hours(1),
            })
            .is_ok());
    }
}
