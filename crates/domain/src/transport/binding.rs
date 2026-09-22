//! Service bindings: `(trust profile, exact peer, purpose) → service principal`.
//!
//! Configuration is authority. A binding set is administrator-controlled,
//! revisioned, and resolved default-deny: exactly one enabled, unrevoked,
//! in-window binding must match on trust profile AND peer AND purpose AND
//! scope, or the peer is not bound.

use super::error::TransportError;
use super::policy::TrustProfileRef;
use super::selector::PeerIdentitySelector;
use super::{timestamp, validate_id, validate_thumbprint};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Upper bound on bindings in one set (bodies are bounded at 64 KiB anyway).
pub const MAX_BINDINGS: usize = 1024;
/// Upper bound on operations, audiences, and denied thumbprints per binding.
pub const MAX_LIST_ENTRIES: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum BindingPurpose {
    NatsAuthBridge,
    WorkerClient,
    IdentityMappingClient,
    TrustedIngress,
    UpstreamConnector,
    ServiceProbe,
}

/// Who owns the binding. A deployment-scoped binding never satisfies an
/// organization-scoped lookup, and vice versa: tenancy is explicit.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum BindingScope {
    Deployment,
    Organization { organization_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ServiceBinding {
    pub id: String,
    pub revision: u32,
    pub enabled: bool,
    pub revoked: bool,
    pub scope: BindingScope,
    pub trust_profile: TrustProfileRef,
    pub peer: PeerIdentitySelector,
    pub service_principal: String,
    pub purpose: BindingPurpose,
    pub allowed_operations: Vec<String>,
    pub allowed_audiences: Vec<String>,
    #[serde(default, with = "timestamp::option")]
    pub not_after: Option<DateTime<Utc>>,
    /// Revoked leaves, even when `peer` is a name selector.
    pub denied_thumbprints: Vec<String>,
}

impl ServiceBinding {
    /// Enabled, not revoked, and inside its window at `now`.
    #[must_use]
    pub fn is_live(&self, now: DateTime<Utc>) -> bool {
        self.enabled && !self.revoked && self.not_after.is_none_or(|t| now < t)
    }

    /// True when the operation is on the allowlist (exact match).
    #[must_use]
    pub fn allows_operation(&self, operation: &str) -> bool {
        self.allowed_operations.iter().any(|op| op == operation)
    }

    /// True when the audience is on the allowlist (exact match). An empty
    /// allowlist admits no audience.
    #[must_use]
    pub fn allows_audience(&self, audience: &str) -> bool {
        self.allowed_audiences.iter().any(|a| a == audience)
    }

    /// Structural validity of one binding.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` naming the offending field.
    pub fn validate(&self) -> Result<(), TransportError> {
        validate_id("binding.id", &self.id)?;
        if self.revision == 0 {
            return Err(TransportError::malformed(format!(
                "binding {}: revision must be > 0",
                self.id
            )));
        }
        if let BindingScope::Organization { organization_id } = &self.scope {
            validate_id("binding.scope.organization_id", organization_id)?;
        }
        self.trust_profile.validate()?;
        self.peer.validate()?;
        validate_id("binding.service_principal", &self.service_principal)?;
        if self.allowed_operations.is_empty() {
            return Err(TransportError::malformed(format!(
                "binding {}: allowed_operations must not be empty",
                self.id
            )));
        }
        validate_list(
            "binding.allowed_operations",
            &self.allowed_operations,
            validate_id,
        )?;
        validate_list(
            "binding.allowed_audiences",
            &self.allowed_audiences,
            validate_id,
        )?;
        validate_list(
            "binding.denied_thumbprints",
            &self.denied_thumbprints,
            validate_thumbprint,
        )?;
        Ok(())
    }
}

fn validate_list(
    field: &str,
    values: &[String],
    check: fn(&str, &str) -> Result<(), TransportError>,
) -> Result<(), TransportError> {
    if values.len() > MAX_LIST_ENTRIES {
        return Err(TransportError::malformed(format!(
            "{field}: more than {MAX_LIST_ENTRIES} entries"
        )));
    }
    let mut seen = BTreeSet::new();
    for value in values {
        check(field, value)?;
        if !seen.insert(value.as_str()) {
            return Err(TransportError::malformed(format!(
                "{field}: duplicate entry"
            )));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct ServiceBindingSet {
    pub revision: u32,
    pub bindings: Vec<ServiceBinding>,
}

impl ServiceBindingSet {
    /// An empty set at revision 1: binds nobody.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            revision: 1,
            bindings: Vec::new(),
        }
    }

    /// Parse and validate a JSON document (the `OPENSESAME_SERVICE_BINDINGS_FILE`
    /// body, the stored `host_kv` value, or a `PUT` body).
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` for any syntax, unknown-field, coercion, or
    /// structural failure; the message never echoes the input.
    pub fn parse_json(json: &str) -> Result<Self, TransportError> {
        let set: Self = serde_json::from_str(json)
            .map_err(|e| TransportError::malformed(format!("service bindings: {e}")))?;
        set.validate()?;
        Ok(set)
    }

    /// Ids unique, revision > 0, every binding valid.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` naming the first violation.
    pub fn validate(&self) -> Result<(), TransportError> {
        if self.revision == 0 {
            return Err(TransportError::malformed(
                "service bindings: revision must be > 0",
            ));
        }
        if self.bindings.len() > MAX_BINDINGS {
            return Err(TransportError::malformed(format!(
                "service bindings: more than {MAX_BINDINGS} bindings"
            )));
        }
        let mut ids = BTreeSet::new();
        for binding in &self.bindings {
            binding.validate()?;
            if !ids.insert(binding.id.as_str()) {
                return Err(TransportError::malformed(format!(
                    "service bindings: duplicate id {}",
                    binding.id
                )));
            }
        }
        Ok(())
    }

    /// Deployment-scoped resolution (see [`Self::resolve_scoped`]).
    ///
    /// # Errors
    ///
    /// As [`Self::resolve_scoped`].
    pub fn resolve(
        &self,
        profile: &TrustProfileRef,
        presented: &[PeerIdentitySelector],
        purpose: BindingPurpose,
        now: DateTime<Utc>,
    ) -> Result<&ServiceBinding, TransportError> {
        self.resolve_scoped(&BindingScope::Deployment, profile, presented, purpose, now)
    }

    /// Default deny. Exactly one live binding in `scope` whose trust profile,
    /// peer selector, and purpose all match must exist.
    ///
    /// # Errors
    ///
    /// - `PeerNotBound`: nothing in this scope names the peer for this
    ///   purpose under this profile.
    /// - `EvidenceRevoked`: a presented leaf thumbprint is on a matching
    ///   binding's `denied_thumbprints` (checked before liveness, so a
    ///   revoked leaf is refused even by a disabled binding).
    /// - `BindingDisabled`: the matches exist but none is enabled, unrevoked,
    ///   and inside its window.
    /// - `AmbiguousBinding`: more than one live match.
    pub fn resolve_scoped(
        &self,
        scope: &BindingScope,
        profile: &TrustProfileRef,
        presented: &[PeerIdentitySelector],
        purpose: BindingPurpose,
        now: DateTime<Utc>,
    ) -> Result<&ServiceBinding, TransportError> {
        let matching: Vec<&ServiceBinding> = self
            .bindings
            .iter()
            .filter(|b| {
                &b.scope == scope
                    && &b.trust_profile == profile
                    && b.purpose == purpose
                    && presented.contains(&b.peer)
            })
            .collect();
        if matching.is_empty() {
            return Err(TransportError::PeerNotBound);
        }
        let presented_thumbprints = presented.iter().filter_map(|s| match s {
            PeerIdentitySelector::LeafThumbprintSha256(t) => Some(t.as_str()),
            _ => None,
        });
        for thumbprint in presented_thumbprints {
            if matching
                .iter()
                .any(|b| b.denied_thumbprints.iter().any(|d| d == thumbprint))
            {
                return Err(TransportError::EvidenceRevoked);
            }
        }
        let mut live = matching.into_iter().filter(|b| b.is_live(now));
        let Some(first) = live.next() else {
            return Err(TransportError::BindingDisabled);
        };
        if live.next().is_some() {
            return Err(TransportError::AmbiguousBinding);
        }
        Ok(first)
    }
}
