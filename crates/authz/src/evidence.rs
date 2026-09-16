//! Requirements are not evidence (POL-EVIDENCE).
//!
//! A grant saying `required_assurance: "mfa"` states what must be true. A
//! request saying `subject.properties.assurance = "mfa"` states what the caller
//! would like the engine to believe. Those two things used to be strings of the
//! same shape, and the difference between them was a convention rather than a
//! type, which is how an assurance requirement could be satisfied by asserting
//! it.
//!
//! Here they are different types:
//!
//! - [`Requirement`] is authored. It is derived from a grant, it is `Serialize`
//!   so a receipt can say what was demanded, and it satisfies nothing by itself.
//! - [`EvidenceLedger`] is verified. It carries no Serde implementation at all —
//!   like `ValidatedGrantChain`, a wire round-trip must not be able to mint one —
//!   and the only way a fact enters it is a trusted verifier calling
//!   [`EvidenceLedger::with_authentication`] and friends after checking it.
//!
//! There is deliberately no `From<Requirement>`, no `From<AuthZenSubject>` and
//! no `Deserialize` anywhere on the evidence side, so "the caller said so"
//! cannot become "the engine verified it" by any conversion the compiler will
//! perform for you. Absence of evidence is a [`PolicyFault`], which resolves to
//! a denial: a requirement whose evidence the engine does not hold has not been
//! met.

use crate::condition::AssuranceLevel;
use crate::error::PolicyFault;
use chrono::{DateTime, Utc};
use opensesame_domain::Grant;
use serde::Serialize;
use std::collections::BTreeSet;

/// The closed set of things policy may demand proof of.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RequirementKind {
    Assurance,
    AuthenticationFreshness,
    HumanApproval,
    ProofOfPossession,
}

impl RequirementKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Assurance => "assurance",
            Self::AuthenticationFreshness => "authentication_freshness",
            Self::HumanApproval => "human_approval",
            Self::ProofOfPossession => "proof_of_possession",
        }
    }
}

/// Something policy demands. Authored, never proof of itself.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "requirement", rename_all = "snake_case")]
pub enum Requirement {
    AssuranceAtLeast {
        level: &'static str,
    },
    AuthenticationNewerThan {
        max_age_seconds: u64,
    },
    /// A human approval bound to exactly this request digest (ADR 0084).
    HumanApproval {
        bound_digest: String,
    },
    ProofOfPossession {
        thumbprint: String,
    },
}

impl Requirement {
    #[must_use]
    pub fn assurance_at_least(level: AssuranceLevel) -> Self {
        Self::AssuranceAtLeast {
            level: level.as_str(),
        }
    }

    #[must_use]
    pub fn kind(&self) -> RequirementKind {
        match self {
            Self::AssuranceAtLeast { .. } => RequirementKind::Assurance,
            Self::AuthenticationNewerThan { .. } => RequirementKind::AuthenticationFreshness,
            Self::HumanApproval { .. } => RequirementKind::HumanApproval,
            Self::ProofOfPossession { .. } => RequirementKind::ProofOfPossession,
        }
    }

    /// Check this requirement against verified evidence.
    ///
    /// # Errors
    ///
    /// Returns [`PolicyFault::MissingEvidence`] when the engine holds no fact of
    /// the required kind, [`PolicyFault::WeakEvidence`] when the fact does not
    /// reach the required strength, and [`PolicyFault::StaleEvidence`] when it is
    /// older than policy allows — or is dated in the future, which is not a
    /// fresher authentication but a broken clock or a forged timestamp.
    pub fn satisfied_by(
        &self,
        evidence: &EvidenceLedger,
        now: DateTime<Utc>,
    ) -> Result<(), PolicyFault> {
        match self {
            Self::AssuranceAtLeast { level } => {
                let required = AssuranceLevel::parse(level)?;
                let held = evidence
                    .authentication()
                    .ok_or(PolicyFault::MissingEvidence(RequirementKind::Assurance))?;
                if held.level() < required {
                    return Err(PolicyFault::WeakEvidence(RequirementKind::Assurance));
                }
                Ok(())
            }
            Self::AuthenticationNewerThan { max_age_seconds } => {
                let kind = RequirementKind::AuthenticationFreshness;
                let held = evidence
                    .authentication()
                    .ok_or(PolicyFault::MissingEvidence(kind))?;
                let at = held.at().ok_or(PolicyFault::MissingEvidence(kind))?;
                let age = now.signed_duration_since(at).num_seconds();
                if age < 0 || age > i64::try_from(*max_age_seconds).unwrap_or(i64::MAX) {
                    return Err(PolicyFault::StaleEvidence(kind));
                }
                Ok(())
            }
            Self::HumanApproval { bound_digest } => {
                if evidence.has_human_approval(bound_digest) {
                    return Ok(());
                }
                Err(PolicyFault::MissingEvidence(RequirementKind::HumanApproval))
            }
            Self::ProofOfPossession { thumbprint } => {
                if evidence.has_proof_of_possession(thumbprint) {
                    return Ok(());
                }
                Err(PolicyFault::MissingEvidence(
                    RequirementKind::ProofOfPossession,
                ))
            }
        }
    }
}

/// Everything policy demands of one request.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Requirements(Vec<Requirement>);

impl Requirements {
    #[must_use]
    pub fn as_slice(&self) -> &[Requirement] {
        &self.0
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn push(&mut self, requirement: Requirement) {
        self.0.push(requirement);
    }

    /// Everything this grant demands proof of.
    ///
    /// # Errors
    ///
    /// Returns a fault when the grant names an assurance level outside the ladder.
    pub fn from_grant(grant: &Grant) -> Result<Self, PolicyFault> {
        let mut requirements = Self::default();
        if let Some(required) = &grant.constraints.required_assurance {
            requirements.push(Requirement::assurance_at_least(AssuranceLevel::parse(
                required,
            )?));
        }
        if let Some(max_age_seconds) = grant.constraints.authentication_max_age_seconds {
            requirements.push(Requirement::AuthenticationNewerThan { max_age_seconds });
        }
        if let Some(thumbprint) = &grant.proof_key_thumbprint {
            requirements.push(Requirement::ProofOfPossession {
                thumbprint: thumbprint.clone(),
            });
        }
        Ok(requirements)
    }

    /// Only the assurance requirement this grant states.
    ///
    /// This is the set the older `PolicyEngine::decide` facade has always
    /// checked. Freshness and proof-of-possession need evidence its callers do
    /// not supply yet, and inventing that evidence to satisfy them would be
    /// worse than not asking: an authentication whose instant nobody recorded
    /// would look as fresh as one that just happened. The strict set is what
    /// `PolicyEngine::evaluate` uses; this one is the migration seam.
    ///
    /// # Errors
    ///
    /// Returns a fault when the grant names an assurance level outside the ladder.
    pub fn assurance_only(grant: &Grant) -> Result<Self, PolicyFault> {
        let mut requirements = Self::default();
        if let Some(required) = &grant.constraints.required_assurance {
            requirements.push(Requirement::assurance_at_least(AssuranceLevel::parse(
                required,
            )?));
        }
        Ok(requirements)
    }

    /// Check every requirement, in the order policy stated them.
    ///
    /// # Errors
    ///
    /// Returns the fault for the first unsatisfied requirement.
    pub fn check(&self, evidence: &EvidenceLedger, now: DateTime<Utc>) -> Result<(), PolicyFault> {
        for requirement in &self.0 {
            requirement.satisfied_by(evidence, now)?;
        }
        Ok(())
    }
}

/// A verified authentication fact.
///
/// `at` is optional and its absence means exactly one thing: the strength was
/// attested but the instant was not. A freshness requirement is then
/// unsatisfiable, which is the fail-closed answer — the alternative, stamping
/// `now` on a fact whose age nobody checked, would make every stale session look
/// like a fresh one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthenticationFact {
    level: AssuranceLevel,
    at: Option<DateTime<Utc>>,
}

impl AuthenticationFact {
    #[must_use]
    pub fn level(self) -> AssuranceLevel {
        self.level
    }

    #[must_use]
    pub fn at(self) -> Option<DateTime<Utc>> {
        self.at
    }
}

/// Facts a trusted verifier established for one request.
///
/// Deliberately not `Serialize`/`Deserialize`: evidence is established in
/// process by whoever checked it, and there is no wire form for "already
/// verified".
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EvidenceLedger {
    authentication: Option<AuthenticationFact>,
    approvals: BTreeSet<String>,
    proof_keys: BTreeSet<String>,
}

impl EvidenceLedger {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a verified authentication. `at` is the instant the authentication
    /// happened, when the verifier knows it.
    #[must_use]
    pub fn with_authentication(mut self, level: AssuranceLevel, at: Option<DateTime<Utc>>) -> Self {
        self.authentication = Some(AuthenticationFact { level, at });
        self
    }

    /// Record a human approval bound to a request digest.
    #[must_use]
    pub fn with_human_approval(mut self, bound_digest: impl Into<String>) -> Self {
        self.approvals.insert(bound_digest.into());
        self
    }

    /// Record a verified proof-of-possession key thumbprint.
    #[must_use]
    pub fn with_proof_of_possession(mut self, thumbprint: impl Into<String>) -> Self {
        self.proof_keys.insert(thumbprint.into());
        self
    }

    #[must_use]
    pub fn authentication(&self) -> Option<AuthenticationFact> {
        self.authentication
    }

    /// Exact-digest match only: an approval of some other request is not an
    /// approval of this one.
    #[must_use]
    pub fn has_human_approval(&self, bound_digest: &str) -> bool {
        self.approvals.contains(bound_digest)
    }

    #[must_use]
    pub fn has_proof_of_possession(&self, thumbprint: &str) -> bool {
        self.proof_keys.contains(thumbprint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_ledger_satisfies_nothing_it_was_asked_for() {
        let now = Utc::now();
        let ledger = EvidenceLedger::new();
        let requirement = Requirement::assurance_at_least(AssuranceLevel::Mfa);
        assert_eq!(
            requirement.satisfied_by(&ledger, now).unwrap_err(),
            PolicyFault::MissingEvidence(RequirementKind::Assurance)
        );
    }

    #[test]
    fn an_attested_level_without_an_instant_cannot_satisfy_freshness() {
        let now = Utc::now();
        let ledger = EvidenceLedger::new().with_authentication(AssuranceLevel::Mfa, None);
        assert!(Requirement::assurance_at_least(AssuranceLevel::Mfa)
            .satisfied_by(&ledger, now)
            .is_ok());
        assert_eq!(
            Requirement::AuthenticationNewerThan {
                max_age_seconds: 600
            }
            .satisfied_by(&ledger, now)
            .unwrap_err(),
            PolicyFault::MissingEvidence(RequirementKind::AuthenticationFreshness)
        );
    }

    #[test]
    fn an_approval_bound_to_another_request_is_not_this_approval() {
        let now = Utc::now();
        let ledger = EvidenceLedger::new().with_human_approval("sha256:aaa");
        assert!(Requirement::HumanApproval {
            bound_digest: "sha256:aaa".into()
        }
        .satisfied_by(&ledger, now)
        .is_ok());
        assert_eq!(
            Requirement::HumanApproval {
                bound_digest: "sha256:bbb".into()
            }
            .satisfied_by(&ledger, now)
            .unwrap_err(),
            PolicyFault::MissingEvidence(RequirementKind::HumanApproval)
        );
    }

    /// AT-APPROVAL-STALE — a digest minted for one intent cannot settle another.
    #[test]
    fn at_approval_stale_bound_digest_mismatch() {
        let now = Utc::now();
        let reviewed = "sha256:reviewed-intent";
        let mutated = "sha256:mutated-intent";
        let ledger = EvidenceLedger::new().with_human_approval(reviewed);
        assert!(Requirement::HumanApproval {
            bound_digest: reviewed.into()
        }
        .satisfied_by(&ledger, now)
        .is_ok());
        assert_eq!(
            Requirement::HumanApproval {
                bound_digest: mutated.into()
            }
            .satisfied_by(&ledger, now)
            .unwrap_err(),
            PolicyFault::MissingEvidence(RequirementKind::HumanApproval)
        );
    }
}
