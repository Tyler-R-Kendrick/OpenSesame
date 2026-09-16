use crate::condition::AssuranceLevel;
use crate::error::DenyReason;
use crate::evaluate::{EvidencePolicy, PolicyQuery};
use crate::evidence::EvidenceLedger;
use crate::{AuthZenDecision, AuthZenRequest};
use chrono::Utc;
use opensesame_domain::{AvailabilityClass, Grant, ValidatedGrantChain};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AuthzError {
    #[error("denied: {0}")]
    Denied(String),
    #[error("step-up required: {0}")]
    StepUpRequired(String),
    #[error("authority quorum unavailable")]
    AuthorityUnavailable,
}

#[derive(Clone, Debug, Default)]
pub struct RelationshipStore {
    /// tuple key "object#relation@user"
    tuples: HashSet<String>,
}

impl RelationshipStore {
    pub fn write(&mut self, object: &str, relation: &str, user: &str) {
        self.tuples.insert(format!("{object}#{relation}@{user}"));
    }

    #[must_use]
    pub fn check(&self, object: &str, relation: &str, user: &str) -> bool {
        self.tuples.contains(&format!("{object}#{relation}@{user}"))
    }
}

#[derive(Clone, Debug)]
pub struct PolicyEngine {
    pub relationships: RelationshipStore,
    pub authority_quorum: bool,
    /// subject -> assurance level, as established by the trusted verifier.
    /// Never populated from a request body; see [`PolicyEngine::verified_evidence`].
    pub assurance: HashMap<String, String>,
}

impl Default for PolicyEngine {
    fn default() -> Self {
        Self {
            relationships: RelationshipStore::default(),
            authority_quorum: true,
            assurance: HashMap::new(),
        }
    }
}

impl PolicyEngine {
    pub(crate) fn relationship_allowed(
        &self,
        req: &AuthZenRequest,
        grant: Option<&Grant>,
        lineage: Option<&ValidatedGrantChain>,
    ) -> bool {
        let subject = &req.subject.id;
        let object = format!("{}:{}", req.resource.type_, req.resource.id);
        let connection = || {
            req.context
                .get("connection_id")
                .and_then(|value| value.as_str())
                .unwrap_or("")
        };
        // A non-null parent_grant_id is raw data, not proof. Only an in-process
        // ValidatedGrantChain may establish delegated eligibility, and only for
        // the exact leaf grant + connection binding the verifier constructed.
        let delegated_capability = lineage.is_some_and(|chain| {
            chain.establishes_delegated_eligibility()
                && grant.is_some_and(|g| chain.binds_grant(g))
                && req
                    .context
                    .get("connection_uuid")
                    .and_then(|value| value.as_str())
                    .is_some_and(|connection_id| {
                        chain.connection_id().map(|id| id.to_string()).as_deref()
                            == Some(connection_id)
                    })
        });
        match req.resource.type_.as_str() {
            "connector_operation" => {
                self.relationships
                    .check(&format!("connection:{}", connection()), "user", subject)
                    || self.relationships.check(&object, "executor", subject)
                    || delegated_capability
            }
            "project" => ["viewer", "developer", "admin"]
                .iter()
                .any(|relation| self.relationships.check(&object, relation, subject)),
            // Authority use names the connection itself; egress binding fences the target.
            "connection" => {
                self.relationships
                    .check(&format!("connection:{}", connection()), "user", subject)
                    || self.relationships.check(&object, "user", subject)
                    || delegated_capability
            }
            "organization" => self.relationships.check(&object, "member", subject),
            // Unknown types never reach here: `ResourceType::parse` faults first.
            _ => false,
        }
    }

    /// The evidence this engine actually holds about a subject.
    ///
    /// The assurance map is written by the trusted verifier from authentication
    /// context, so a level found here is verified. An instant is not recorded on
    /// this path, and none is invented: freshness therefore cannot be satisfied
    /// from it, which is why `decide` asks only for
    /// [`EvidencePolicy::AssuranceOnly`].
    #[must_use]
    pub fn verified_evidence(&self, subject: &str) -> EvidenceLedger {
        match self
            .assurance
            .get(subject)
            .map(String::as_str)
            .map(AssuranceLevel::parse)
        {
            Some(Ok(level)) => EvidenceLedger::new().with_authentication(level, None),
            // An unrecognized level is not a weak level, it is no evidence.
            // It used to rank as zero, which made any requirement nobody
            // recognized satisfiable by holding nothing.
            Some(Err(_)) | None => EvidenceLedger::new(),
        }
    }

    /// AuthZEN-shaped decision.
    ///
    /// Built from the same typed layers as [`PolicyEngine::evaluate`]; the
    /// difference is the evidence set it insists on (see [`EvidencePolicy`]).
    ///
    /// # Errors
    ///
    /// Returns [`AuthzError::AuthorityUnavailable`] when a class that needs the
    /// authority plane cannot reach it, and [`AuthzError::StepUpRequired`] when
    /// the denial was an assurance requirement the held evidence does not meet.
    /// Every other refusal is a decision, not an error.
    pub fn decide(
        &self,
        req: &AuthZenRequest,
        grant: Option<&Grant>,
        lineage: Option<&ValidatedGrantChain>,
        class: AvailabilityClass,
    ) -> Result<AuthZenDecision, AuthzError> {
        let evidence = self.verified_evidence(&req.subject.id);
        let query = PolicyQuery {
            request: req,
            grant,
            lineage,
            class,
            evidence: &evidence,
            evidence_policy: EvidencePolicy::AssuranceOnly,
            now: Utc::now(),
        };
        let verdict = self.evaluate(&query);
        if verdict.step_up_required().is_some() {
            // Report the level the grant asked for in the grant's own spelling.
            let required = grant
                .and_then(|g| g.constraints.required_assurance.clone())
                .unwrap_or_else(|| {
                    verdict
                        .step_up_required()
                        .map_or_else(String::new, |level| level.as_str().to_owned())
                });
            return Err(AuthzError::StepUpRequired(required));
        }
        if verdict.reason().and_then(DenyReason::fault)
            == Some(&crate::error::PolicyFault::AuthorityUnavailable)
        {
            return Err(AuthzError::AuthorityUnavailable);
        }
        let mut decision = verdict.decision();
        decision.context = json!({
            "reason": verdict.reason().map(DenyReason::code),
            "action": req.action.name,
            "explanation": verdict.explanation().to_json(),
        });
        Ok(decision)
    }
}
