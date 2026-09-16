//! The fail-closed evaluation pipeline.
//!
//! One question per layer, one combining rule, one explanation. Every layer
//! returns a [`LayerOutcome`] instead of returning early, so a decision is a
//! value that can be inspected rather than a control-flow path that can be
//! read the wrong way — and a layer that cannot answer says so
//! ([`Effect::Indeterminate`]) rather than declining to object.
//!
//! [`PolicyEngine::evaluate`] is the strict entry point: a requirement with no
//! evidence behind it denies, a stated audience the request omits denies, a
//! resource type outside the closed set denies, and an expired grant denies.
//! `PolicyEngine::decide` remains the AuthZEN-shaped facade its callers already
//! use and is built on the same types, one layer at a time.

use crate::combine::{deny_overrides, Combination, Effect, LayerOutcome, PolicyLayer};
use crate::condition::AssuranceLevel;
use crate::condition_set::{ConditionSet, RequestFacts, ResourceFact};
use crate::error::{DenyReason, PolicyFault, UnknownTerm};
use crate::evidence::{EvidenceLedger, RequirementKind, Requirements};
use crate::explain::Explanation;
use crate::{
    policy_version_digest, AuthZenDecision, AuthZenObligation, AuthZenRequest, AuthzError,
    PolicyEngine,
};
use chrono::{DateTime, Utc};
use opensesame_domain::{AvailabilityClass, Grant, InvokeLevel, OfflineUse, ValidatedGrantChain};
use serde_json::json;
use uuid::Uuid;

/// The closed set of resource types this engine knows how to fence.
///
/// An unrecognized type used to fall through to a `viewer` tuple check, so a
/// type nobody had modelled was authorized by whichever relation happened to
/// look closest. There is no such fall-through now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResourceType {
    ConnectorOperation,
    Connection,
    Project,
    Organization,
}

impl ResourceType {
    /// # Errors
    ///
    /// Returns [`PolicyFault::Unknown`] for a type outside the closed set.
    pub fn parse(name: &str) -> Result<Self, PolicyFault> {
        match name {
            "connector_operation" => Ok(Self::ConnectorOperation),
            "connection" => Ok(Self::Connection),
            "project" => Ok(Self::Project),
            "organization" => Ok(Self::Organization),
            other => Err(PolicyFault::Unknown(UnknownTerm::ResourceType(
                other.to_owned(),
            ))),
        }
    }

    /// Whether this type's id lives in the grant's resource selector namespace.
    #[must_use]
    pub fn resource_scoped(self) -> bool {
        matches!(self, Self::ConnectorOperation)
    }
}

/// Which of a grant's requirements this evaluation will insist on.
///
/// Named, not defaulted, because the difference between the two is a security
/// difference and a caller should have to state which one it is asking for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvidencePolicy {
    /// Every requirement the grant states: assurance, authentication freshness,
    /// proof of possession.
    Strict,
    /// Assurance only — what the `decide` facade's callers can supply evidence
    /// for today. A migration seam, not a way to switch a requirement off:
    /// nothing weakens on the [`Self::Strict`] path, and the requirements this
    /// skips deny rather than pass there.
    AssuranceOnly,
}

/// Everything one decision is made from.
pub struct PolicyQuery<'a> {
    pub request: &'a AuthZenRequest,
    pub grant: Option<&'a Grant>,
    /// Verified lineage. Raw `parent_grant_id` pointers are not lineage.
    pub lineage: Option<&'a ValidatedGrantChain>,
    pub class: AvailabilityClass,
    /// Facts a trusted verifier established for this request.
    pub evidence: &'a EvidenceLedger,
    pub evidence_policy: EvidencePolicy,
    pub now: DateTime<Utc>,
}

/// A decision, its obligations and its explanation.
pub struct Verdict {
    combination: Combination,
    explanation: Explanation,
    step_up: Option<AssuranceLevel>,
}

impl Verdict {
    #[must_use]
    pub fn permitted(&self) -> bool {
        self.combination.permitted()
    }

    #[must_use]
    pub fn reason(&self) -> Option<&DenyReason> {
        self.combination.reason()
    }

    #[must_use]
    pub fn obligations(&self) -> &[AuthZenObligation] {
        self.combination.obligations()
    }

    #[must_use]
    pub fn explanation(&self) -> &Explanation {
        &self.explanation
    }

    /// The assurance level a step-up would have to reach, when that is what the
    /// denial was about. Policy's requirement, never what the caller holds.
    #[must_use]
    pub fn step_up_required(&self) -> Option<AssuranceLevel> {
        self.step_up
    }

    /// The AuthZEN-shaped decision, explanation included.
    #[must_use]
    pub fn decision(&self) -> AuthZenDecision {
        AuthZenDecision {
            decision: self.permitted(),
            decision_id: format!("dec:{}", Uuid::new_v4()),
            policy_version_digest: policy_version_digest(),
            obligations: self.obligations().to_vec(),
            context: json!({
                "reason": self.reason().map(DenyReason::code),
                "explanation": self.explanation.to_json(),
            }),
        }
    }

    /// The denial as this crate's error type, for callers on the older surface.
    #[must_use]
    pub fn as_authz_error(&self) -> Option<AuthzError> {
        let reason = self.reason()?;
        if let Some(level) = self.step_up {
            return Some(AuthzError::StepUpRequired(level.as_str().to_owned()));
        }
        if reason.fault() == Some(&PolicyFault::AuthorityUnavailable) {
            return Some(AuthzError::AuthorityUnavailable);
        }
        Some(AuthzError::Denied(reason.to_string()))
    }
}

impl PolicyEngine {
    /// Evaluate a request strictly: unknown terms, missing evidence and stated
    /// restrictions the request says nothing about all deny.
    #[must_use]
    pub fn evaluate(&self, query: &PolicyQuery<'_>) -> Verdict {
        let resource_type = ResourceType::parse(&query.request.resource.type_);
        let conditions = effective_conditions(query);
        let outcomes = vec![
            self.availability_layer(query),
            self.relationship_layer(query, resource_type.clone()),
            lineage_layer(query),
            grant_authority_layer(query),
            conditions_layer(query, resource_type, conditions),
            evidence_layer(query),
            executability_layer(query),
        ];
        let combination = deny_overrides(outcomes);
        let step_up = step_up_level(query, combination.reason());
        Verdict {
            explanation: Explanation::of(&combination),
            combination,
            step_up,
        }
    }

    fn availability_layer(&self, query: &PolicyQuery<'_>) -> LayerOutcome {
        let offline_permitted = query
            .grant
            .is_some_and(|grant| grant.constraints.offline_use == OfflineUse::PreAuthorized);
        let reachable = match query.class {
            AvailabilityClass::A0Local => true,
            AvailabilityClass::A1Preauthorized => self.authority_quorum || offline_permitted,
            AvailabilityClass::A2AuthorityRequired | AvailabilityClass::A3ExternalSideEffect => {
                self.authority_quorum
            }
        };
        if reachable {
            LayerOutcome::permit(PolicyLayer::Availability)
        } else {
            LayerOutcome::fault(PolicyLayer::Availability, PolicyFault::AuthorityUnavailable)
        }
    }

    fn relationship_layer(
        &self,
        query: &PolicyQuery<'_>,
        resource_type: Result<ResourceType, PolicyFault>,
    ) -> LayerOutcome {
        match resource_type {
            Err(fault) => LayerOutcome::fault(PolicyLayer::Relationship, fault),
            Ok(_) if self.relationship_allowed(query.request, query.grant, query.lineage) => {
                LayerOutcome::permit(PolicyLayer::Relationship)
            }
            Ok(_) => LayerOutcome::deny(PolicyLayer::Relationship, DenyReason::Relationship),
        }
    }
}

/// The authority a chain actually leaves, or the grant's own when there is no
/// chain. A fault here is the layer's problem, so it is deferred to it.
fn effective_conditions(query: &PolicyQuery<'_>) -> Option<Result<ConditionSet, PolicyFault>> {
    match (query.lineage, query.grant) {
        (Some(chain), _) => Some(ConditionSet::effective(chain)),
        (None, Some(grant)) => Some(ConditionSet::from_grant(grant)),
        (None, None) => None,
    }
}

fn lineage_layer(query: &PolicyQuery<'_>) -> LayerOutcome {
    let Some(chain) = query.lineage else {
        return LayerOutcome::not_applicable(PolicyLayer::Lineage);
    };
    if query.grant.is_some_and(|grant| !chain.binds_grant(grant)) {
        return LayerOutcome::deny(PolicyLayer::Lineage, DenyReason::LineageUnbound);
    }
    match ConditionSet::lineage_widening(chain) {
        Err(fault) => LayerOutcome::fault(PolicyLayer::Lineage, fault),
        Ok(Some(kind)) => {
            LayerOutcome::deny(PolicyLayer::Lineage, DenyReason::LineageWidened(kind))
        }
        Ok(None) => LayerOutcome::permit(PolicyLayer::Lineage),
    }
}

fn grant_authority_layer(query: &PolicyQuery<'_>) -> LayerOutcome {
    match query.grant {
        Some(_) => LayerOutcome::permit(PolicyLayer::GrantAuthority),
        // No grant is not a denial by itself — a relationship tuple authorizes
        // reads. It *is* a denial for anything that needs one.
        None if exports_raw_credential(query.request) => {
            LayerOutcome::deny(PolicyLayer::GrantAuthority, DenyReason::ExportDefaultDeny)
        }
        None => LayerOutcome::not_applicable(PolicyLayer::GrantAuthority),
    }
}

fn conditions_layer(
    query: &PolicyQuery<'_>,
    resource_type: Result<ResourceType, PolicyFault>,
    conditions: Option<Result<ConditionSet, PolicyFault>>,
) -> LayerOutcome {
    let Some(conditions) = conditions else {
        return LayerOutcome::not_applicable(PolicyLayer::Conditions);
    };
    // A term neither the grant nor the request could be read against is a fault,
    // reported as the fault it was rather than flattened into a generic one.
    let conditions = match conditions {
        Ok(conditions) => conditions,
        Err(fault) => return LayerOutcome::fault(PolicyLayer::Conditions, fault),
    };
    let resource_type = match resource_type {
        Ok(resource_type) => resource_type,
        Err(fault) => return LayerOutcome::fault(PolicyLayer::Conditions, fault),
    };
    match conditions.check(&facts_of(query, resource_type)) {
        Ok(()) => LayerOutcome::permit(PolicyLayer::Conditions),
        Err(reason) => LayerOutcome::deny(PolicyLayer::Conditions, reason),
    }
}

fn evidence_layer(query: &PolicyQuery<'_>) -> LayerOutcome {
    let Some(grant) = query
        .grant
        .or_else(|| query.lineage.map(ValidatedGrantChain::leaf))
    else {
        return LayerOutcome::not_applicable(PolicyLayer::Evidence);
    };
    let stated = match query.evidence_policy {
        EvidencePolicy::Strict => Requirements::from_grant(grant),
        EvidencePolicy::AssuranceOnly => Requirements::assurance_only(grant),
    };
    let requirements = match stated {
        Ok(requirements) => requirements,
        Err(fault) => return LayerOutcome::fault(PolicyLayer::Evidence, fault),
    };
    if requirements.is_empty() {
        return LayerOutcome::not_applicable(PolicyLayer::Evidence);
    }
    match requirements.check(query.evidence, query.now) {
        Ok(()) => LayerOutcome::permit(PolicyLayer::Evidence),
        Err(fault) => LayerOutcome::fault(PolicyLayer::Evidence, fault),
    }
}

fn executability_layer(query: &PolicyQuery<'_>) -> LayerOutcome {
    if query
        .request
        .context
        .get("discovery_only")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        return LayerOutcome::deny(PolicyLayer::Executability, DenyReason::DiscoveryNotExecute);
    }
    LayerOutcome::permit_with(
        PolicyLayer::Executability,
        vec![AuthZenObligation {
            id: "receipt.required".into(),
            attributes: json!({"signed": true}),
        }],
    )
}

fn facts_of<'a>(query: &'a PolicyQuery<'a>, resource_type: ResourceType) -> RequestFacts<'a> {
    let request = query.request;
    RequestFacts {
        action: &request.action.name,
        resource: if resource_type.resource_scoped() {
            ResourceFact::Named(&request.resource.id)
        } else {
            ResourceFact::NotResourceScoped
        },
        audience: request
            .context
            .get("audience")
            .and_then(serde_json::Value::as_str),
        invoke_level: invoke_level_of(request),
        exports_raw_credential: exports_raw_credential(request),
        at: query.now,
    }
}

fn invoke_level_of(request: &AuthZenRequest) -> Option<InvokeLevel> {
    match request
        .context
        .get("invoke_level")
        .and_then(serde_json::Value::as_u64)
    {
        Some(1) => Some(InvokeLevel::TypedOperation),
        Some(2) => Some(InvokeLevel::ConstrainedHttp),
        Some(3) => Some(InvokeLevel::Materialize),
        _ => None,
    }
}

fn exports_raw_credential(request: &AuthZenRequest) -> bool {
    request.action.name == "credential.export"
        || invoke_level_of(request) == Some(InvokeLevel::Materialize)
}

/// The level a step-up would have to reach — read off the grant's requirement,
/// not off anything the caller sent.
fn step_up_level(query: &PolicyQuery<'_>, reason: Option<&DenyReason>) -> Option<AssuranceLevel> {
    let fault = reason?.fault()?;
    let assurance_fault = matches!(
        fault,
        PolicyFault::MissingEvidence(RequirementKind::Assurance)
            | PolicyFault::WeakEvidence(RequirementKind::Assurance)
    );
    if !assurance_fault {
        return None;
    }
    let grant = query
        .grant
        .or_else(|| query.lineage.map(ValidatedGrantChain::leaf))?;
    let required = grant.constraints.required_assurance.as_deref()?;
    AssuranceLevel::parse(required).ok()
}

/// Layer verdicts a caller may want to assert on without rebuilding the pipeline.
#[must_use]
pub fn permitted_layer(verdict: &Verdict, layer: PolicyLayer) -> bool {
    verdict.explanation().layer_effect(layer, Effect::Permit)
}
