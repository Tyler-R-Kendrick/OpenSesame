//! Temporary access domains: a deadline that cannot be escaped by nesting.
//!
//! A domain may be permanent or TTL-bound. Two rules keep a deadline honest
//! once domains nest:
//!
//! 1. **Nothing permanent hangs under something temporary.** Otherwise the
//!    parent's expiry would orphan authority nobody meant to lose, and the
//!    subtree would have to be either silently promoted or silently destroyed.
//!    Both are worse than refusing the arrangement.
//! 2. **A child never outlives its parent.** A deadline you can extend by
//!    creating a grandchild is not a deadline.
//!
//! The deadline is published, not enforced, by the `lifecycle.*` feed
//! (ADR 0074). [`DomainLifetime::assert_active`] is what actually stops
//! access, so a scanner that misses a tick cannot extend anybody's reach.

use crate::DomainError;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// The longest a temporary domain may run.
///
/// Thirty days matches the outer edge of a claims-flow engagement. Past that a
/// caller is describing an estate, not a visit, and should create a standard
/// domain that someone has to decide to remove.
pub const MAX_TEMPORARY_DOMAIN_LIFETIME: Duration = Duration::days(30);

/// Whether a domain is on a clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum DomainLifetime {
    /// No deadline. Removal is somebody's explicit decision.
    Permanent,
    /// Gone at `expires_at`, whether or not anyone acts.
    Temporary { expires_at: DateTime<Utc> },
}

impl DomainLifetime {
    /// The deadline, if there is one. This is the value the lifecycle scanner
    /// reads; it is metadata and names nothing secret.
    #[must_use]
    pub fn deadline(&self) -> Option<DateTime<Utc>> {
        match self {
            Self::Permanent => None,
            Self::Temporary { expires_at } => Some(*expires_at),
        }
    }

    #[must_use]
    pub fn is_temporary(&self) -> bool {
        matches!(self, Self::Temporary { .. })
    }

    /// Whether this lifetime has run out at the caller's clock reading.
    #[must_use]
    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        self.deadline().is_some_and(|deadline| now >= deadline)
    }

    /// The check that actually stops access.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainExpired`] once `now` has reached the
    /// deadline.
    pub fn assert_active(&self, now: DateTime<Utc>) -> Result<(), DomainError> {
        if self.is_expired(now) {
            return Err(DomainError::AccessDomainExpired);
        }
        Ok(())
    }

    /// Whether a lifetime is sane for a domain created at `created_at`.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainLifetime`] when the deadline is already past
    /// at creation (a domain that was never usable) or beyond
    /// [`MAX_TEMPORARY_DOMAIN_LIFETIME`].
    pub fn assert_well_formed(&self, created_at: DateTime<Utc>) -> Result<(), DomainError> {
        let Some(expires_at) = self.deadline() else {
            return Ok(());
        };
        if expires_at <= created_at {
            return Err(DomainError::AccessDomainLifetime(
                "temporary domain expires at or before it is created".to_string(),
            ));
        }
        if expires_at - created_at > MAX_TEMPORARY_DOMAIN_LIFETIME {
            return Err(DomainError::AccessDomainLifetime(format!(
                "temporary domain lifetime exceeds {} days",
                MAX_TEMPORARY_DOMAIN_LIFETIME.num_days()
            )));
        }
        Ok(())
    }

    /// Whether this lifetime is admissible directly beneath `parent`.
    ///
    /// # Errors
    ///
    /// [`DomainError::AccessDomainLifetime`] when a permanent domain would sit
    /// under a temporary one, or when a child's deadline would fall after its
    /// parent's.
    pub fn assert_within(&self, parent: &Self) -> Result<(), DomainError> {
        let Some(parent_deadline) = parent.deadline() else {
            return Ok(());
        };
        match self.deadline() {
            None => Err(DomainError::AccessDomainLifetime(
                "a permanent domain cannot hang under a temporary one".to_string(),
            )),
            Some(own) if own > parent_deadline => Err(DomainError::AccessDomainLifetime(
                "a child domain cannot outlive its parent".to_string(),
            )),
            Some(_) => Ok(()),
        }
    }

    /// The lifetime this one becomes when placed under `parent`: the earlier of
    /// the two deadlines.
    ///
    /// Callers use this to *propose* a legal lifetime. It is deliberately not
    /// applied implicitly by the forest — silently shortening a caller's
    /// deadline is as surprising as silently extending it, so the forest
    /// refuses and the caller decides.
    #[must_use]
    pub fn narrowed_to(&self, parent: &Self) -> Self {
        match (self.deadline(), parent.deadline()) {
            (_, None) => *self,
            (None, Some(parent_deadline)) => Self::Temporary {
                expires_at: parent_deadline,
            },
            (Some(own), Some(parent_deadline)) => Self::Temporary {
                expires_at: own.min(parent_deadline),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(day: u32) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(&format!("2026-03-{day:02}T00:00:00Z"))
            .expect("fixture timestamp")
            .with_timezone(&Utc)
    }

    fn until(day: u32) -> DomainLifetime {
        DomainLifetime::Temporary {
            expires_at: at(day),
        }
    }

    #[test]
    fn permanent_never_expires() {
        assert!(!DomainLifetime::Permanent.is_expired(at(1)));
        assert!(DomainLifetime::Permanent.assert_active(at(28)).is_ok());
        assert_eq!(DomainLifetime::Permanent.deadline(), None);
    }

    #[test]
    fn temporary_expires_at_the_deadline_not_after_it() {
        let lifetime = until(10);
        assert!(lifetime.assert_active(at(9)).is_ok());
        assert_eq!(
            lifetime.assert_active(at(10)),
            Err(DomainError::AccessDomainExpired)
        );
    }

    #[test]
    fn permanent_under_temporary_is_refused() {
        assert!(DomainLifetime::Permanent.assert_within(&until(10)).is_err());
    }

    #[test]
    fn child_cannot_outlive_parent() {
        assert!(until(11).assert_within(&until(10)).is_err());
        assert!(until(10).assert_within(&until(10)).is_ok());
        assert!(until(9).assert_within(&until(10)).is_ok());
    }

    #[test]
    fn anything_fits_under_a_permanent_parent() {
        assert!(until(10).assert_within(&DomainLifetime::Permanent).is_ok());
        assert!(DomainLifetime::Permanent
            .assert_within(&DomainLifetime::Permanent)
            .is_ok());
    }

    #[test]
    fn narrowing_takes_the_earlier_deadline() {
        assert_eq!(until(11).narrowed_to(&until(10)), until(10));
        assert_eq!(until(9).narrowed_to(&until(10)), until(9));
        assert_eq!(DomainLifetime::Permanent.narrowed_to(&until(10)), until(10));
        assert_eq!(until(10).narrowed_to(&DomainLifetime::Permanent), until(10));
    }

    #[test]
    fn a_narrowed_lifetime_always_fits() {
        for child in [DomainLifetime::Permanent, until(9), until(11)] {
            let parent = until(10);
            assert!(child.narrowed_to(&parent).assert_within(&parent).is_ok());
        }
    }

    #[test]
    fn lifetime_must_be_positive_and_bounded() {
        let created = at(1);
        assert!(until(2).assert_well_formed(created).is_ok());
        assert!(until(1).assert_well_formed(created).is_err());
        assert!(DomainLifetime::Temporary {
            expires_at: created + MAX_TEMPORARY_DOMAIN_LIFETIME + Duration::seconds(1),
        }
        .assert_well_formed(created)
        .is_err());
        assert!(DomainLifetime::Permanent
            .assert_well_formed(created)
            .is_ok());
    }
}
