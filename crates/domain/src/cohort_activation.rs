//! Turning eligibility into authority, one principal at a time.
//!
//! This is the module the rest of the cohort machinery exists to reach, and the
//! one place the central rule is enforced:
//!
//! **A group never acts. A named principal acts, and the group is only why they
//! were allowed to.**
//!
//! ## Why there is no cohort token
//!
//! The obvious shortcut is to mint one credential for "the reviewers" and let any
//! member present it. Every part of that is wrong for this system:
//!
//! - A receipt naming a group names nobody. Two hours later, "who approved this"
//!   has no answer, and the receipt chain that the whole product rests on is
//!   broken at exactly the step a human took.
//! - A shared secret leaves the group. A member can hand it to a contractor, a
//!   script, or an agent, and nothing downstream can tell the difference — the
//!   credential says "a reviewer" and that remains true.
//! - Removal stops working. Taking somebody out of the cohort does not claw back
//!   a bearer token they already hold, so revocation silently becomes re-keying
//!   for everyone.
//!
//! So a [`CohortActivation`] is a **record, not a credential**. It carries no
//! secret, nothing in it is presented as proof of anything, and it is safe to log
//! whole. It names one `subject_principal_id`, who must still authenticate as
//! themselves by whatever means they always would; the activation only answers
//! "was this individual eligible, on what basis, for which request".
//!
//! Because it holds no secret, a leaked activation is not a leaked authority —
//! and even if it were replayed, it is bound to one request digest and spent by a
//! compare-and-set, so it cannot settle a second thing (the same discipline ADR
//! 0084 applies to sensitive approvals).

use crate::{
    AdmissionBasis, AdmissionRecord, Cohort, CohortActivationId, CohortId, DomainError,
    Eligibility, PrincipalId,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// The longest an activation may stand.
///
/// An hour. An activation is the binding for one request, not a session: it is
/// minted when somebody is about to act and is spent when they do. The ceiling
/// matters most for a snapshot cohort, where the roster itself does not expire —
/// this is what bounds how long a since-removed member's binding stays good.
pub const MAX_ACTIVATION_LIFETIME: Duration = Duration::hours(1);

/// The shortest an activation may stand. Below this it is over before the subject
/// can act on it, which is a mistake rather than a tight policy.
pub const MIN_ACTIVATION_LIFETIME: Duration = Duration::seconds(30);

/// One principal, bound to one request, on a recorded basis.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CohortActivation {
    pub id: CohortActivationId,
    pub cohort_id: CohortId,
    /// The one principal this activation is about. Never a set, never a role,
    /// never "any member" — see the module note.
    pub subject_principal_id: PrincipalId,
    /// Why the subject was eligible, copied from the basis at mint time.
    ///
    /// Copied rather than re-derived so the explanation cannot drift from the
    /// decision: the path recorded here is the one that actually admitted them,
    /// even if the graph has moved since.
    pub eligibility: Eligibility,
    /// Which snapshot, or which live reading, admitted them.
    pub basis: AdmissionRecord,
    /// The one request this activation may settle.
    ///
    /// A digest supplied by the caller, over whatever it is the subject is about
    /// to do. It is what stops an activation minted for a read being spent on a
    /// write, and what stops one member's activation being reused for another
    /// member's request.
    pub request_digest: String,
    pub activated_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    /// Set when it was spent. Single use.
    pub spent_at: Option<DateTime<Utc>>,
}

/// Everything a new activation needs, named.
///
/// A struct rather than positional arguments: `subject_principal_id` would
/// otherwise sit beside other ids of the same type, one transposition away from
/// binding the wrong person.
#[derive(Clone, Debug)]
pub struct NewCohortActivation<'a> {
    pub id: CohortActivationId,
    /// The cohort as stored — its declared [`AdmissionMode`](crate::AdmissionMode)
    /// is what the basis is held to.
    pub cohort: &'a Cohort,
    pub basis: AdmissionBasis<'a>,
    pub subject_principal_id: PrincipalId,
    pub request_digest: String,
    pub activated_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

impl CohortActivation {
    /// Bind an individual, or refuse.
    ///
    /// The order is deliberate and must not be rearranged: the basis is checked
    /// against the cohort *before* the subject is looked up in it, so a
    /// wrong-mode or stale basis is refused as a basis rather than as "not
    /// eligible". The two are different diagnoses and an operator chasing the
    /// second when the first is true will change the wrong thing.
    ///
    /// # Errors
    ///
    /// - Anything [`AdmissionBasis::assert_usable`] raises — wrong cohort, wrong
    ///   mode, stale live reading, closed or tampered snapshot.
    /// - [`DomainError::CohortNotEligible`] when the basis does not admit the
    ///   subject. This is the deny-by-default branch: absence from the roster is
    ///   a refusal, never an unknown.
    /// - [`DomainError::CohortActivationBindingMismatch`] for an empty request
    ///   digest. An unbound activation would be a small bearer token, which is
    ///   the thing this module refuses to have.
    /// - [`DomainError::CohortActivationLifetime`] outside
    ///   [`MIN_ACTIVATION_LIFETIME`]..=[`MAX_ACTIVATION_LIFETIME`]. Refused
    ///   rather than clamped, so a caller that asked for a day is told it cannot
    ///   have one instead of believing it did.
    pub fn mint(spec: NewCohortActivation<'_>) -> Result<Self, DomainError> {
        let NewCohortActivation {
            id,
            cohort,
            basis,
            subject_principal_id,
            request_digest,
            activated_at,
            expires_at,
        } = spec;

        basis.assert_usable(cohort, activated_at)?;

        if request_digest.trim().is_empty() {
            return Err(DomainError::CohortActivationBindingMismatch(
                "an activation must name the request it settles".into(),
            ));
        }

        let lifetime = expires_at - activated_at;
        if lifetime < MIN_ACTIVATION_LIFETIME {
            return Err(DomainError::CohortActivationLifetime(format!(
                "{} seconds is shorter than the {} second minimum",
                lifetime.num_seconds(),
                MIN_ACTIVATION_LIFETIME.num_seconds()
            )));
        }
        if lifetime > MAX_ACTIVATION_LIFETIME {
            return Err(DomainError::CohortActivationLifetime(format!(
                "{} seconds is longer than the {} second maximum",
                lifetime.num_seconds(),
                MAX_ACTIVATION_LIFETIME.num_seconds()
            )));
        }

        let eligibility = basis
            .eligibility(subject_principal_id)
            .ok_or_else(|| {
                DomainError::CohortNotEligible(format!(
                    "{subject_principal_id} is not admitted by the {} basis for {}",
                    basis.mode().as_str(),
                    cohort.id
                ))
            })?
            .clone();

        Ok(Self {
            id,
            cohort_id: cohort.id,
            subject_principal_id,
            eligibility,
            basis: basis.record()?,
            request_digest,
            activated_at,
            expires_at,
            spent_at: None,
        })
    }

    /// Whether this activation is still standing.
    ///
    /// # Errors
    ///
    /// [`DomainError::CohortActivationSpent`] once spent, or
    /// [`DomainError::GrantTimeWindow`] outside its window.
    pub fn assert_active(&self, now: DateTime<Utc>) -> Result<(), DomainError> {
        if self.spent_at.is_some() {
            return Err(DomainError::CohortActivationSpent);
        }
        if now < self.activated_at || now >= self.expires_at {
            return Err(DomainError::GrantTimeWindow);
        }
        Ok(())
    }

    /// Whether this activation authorizes `principal_id` to settle
    /// `request_digest`, right now.
    ///
    /// One function on purpose, for the same reason
    /// [`SessionGrant::permits`](crate::SessionGrant::permits) is one function: a
    /// caller who checked the subject but forgot the request, or the request but
    /// forgot the clock, is the bug this shape prevents. In particular, a caller
    /// that checked only the cohort would have built the cohort-wide bearer token
    /// this module is written to prevent.
    ///
    /// The subject comparison is against the *authenticated* caller — this returns
    /// false for every principal but the one named, including other members of the
    /// same cohort.
    #[must_use]
    pub fn authorizes(
        &self,
        principal_id: PrincipalId,
        request_digest: &str,
        now: DateTime<Utc>,
    ) -> bool {
        self.subject_principal_id == principal_id
            && self.request_digest == request_digest
            && self.assert_active(now).is_ok()
    }

    /// Spend it.
    ///
    /// Single use, and the caller is expected to persist this with a
    /// compare-and-set on `spent_at` so two concurrent requests cannot both
    /// settle on one activation.
    ///
    /// # Errors
    ///
    /// As [`CohortActivation::assert_active`].
    pub fn spend(self, now: DateTime<Utc>) -> Result<Self, DomainError> {
        self.assert_active(now)?;
        Ok(Self {
            spent_at: Some(now),
            ..self
        })
    }
}
