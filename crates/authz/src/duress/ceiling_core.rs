//! Operation deny ceilings bound to durable duress epochs.

use std::collections::BTreeSet;

use opensesame_domain::AuthorityOperation;

/// Host authority boundary operations covered by a duress deny ceiling.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BoundaryOp {
    Authorize,
    Mint,
    Renew,
    Invoke,
    Sign,
    KeyRelease,
}

impl BoundaryOp {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Authorize => "authorize",
            Self::Mint => "mint",
            Self::Renew => "renew",
            Self::Invoke => "invoke",
            Self::Sign => "sign",
            Self::KeyRelease => "key_release",
        }
    }

    /// Map a domain authority operation onto a ceiling-checked boundary.
    ///
    /// Describe / encrypt / decrypt are out of ceiling scope (metadata or
    /// sealed transforms that do not mint or release capability).
    #[must_use]
    pub const fn from_authority_operation(op: AuthorityOperation) -> Option<Self> {
        match op {
            AuthorityOperation::Authorize => Some(Self::Authorize),
            AuthorityOperation::Mint => Some(Self::Mint),
            AuthorityOperation::Lease | AuthorityOperation::Exchange | AuthorityOperation::Rotate => {
                Some(Self::Renew)
            }
            AuthorityOperation::Invoke => Some(Self::Invoke),
            AuthorityOperation::Sign => Some(Self::Sign),
            AuthorityOperation::Resolve => Some(Self::KeyRelease),
            AuthorityOperation::Describe
            | AuthorityOperation::Encrypt
            | AuthorityOperation::Decrypt => None,
        }
    }
}

/// Epoch triple frozen into an incident / `AccessContext` (INV-09, INV-13).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EpochTriple {
    pub policy_epoch: u64,
    pub key_epoch: u64,
    pub incident_epoch: u64,
}

impl EpochTriple {
    #[must_use]
    pub const fn matches(self, other: Self) -> bool {
        self.policy_epoch == other.policy_epoch
            && self.key_epoch == other.key_epoch
            && self.incident_epoch == other.incident_epoch
    }
}

/// Active deny ceiling for one independent-authority incident scope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DenyCeiling {
    pub ceiling_ref: String,
    pub denied: BTreeSet<BoundaryOp>,
    pub epochs: EpochTriple,
}

impl DenyCeiling {
    /// Restrictive preset used by approval-duress / locked independent holds:
    /// every capability boundary is denied.
    #[must_use]
    pub fn deny_all_boundaries(ceiling_ref: impl Into<String>, epochs: EpochTriple) -> Self {
        let mut denied = BTreeSet::new();
        denied.insert(BoundaryOp::Authorize);
        denied.insert(BoundaryOp::Mint);
        denied.insert(BoundaryOp::Renew);
        denied.insert(BoundaryOp::Invoke);
        denied.insert(BoundaryOp::Sign);
        denied.insert(BoundaryOp::KeyRelease);
        Self {
            ceiling_ref: ceiling_ref.into(),
            denied,
            epochs,
        }
    }

    #[must_use]
    pub fn denies(&self, op: BoundaryOp) -> bool {
        self.denied.contains(&op)
    }
}

/// Whether the Host has already dispatched work for this boundary attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DispatchState {
    NotStarted,
    /// Work already left this Host. Ceiling evaluation must not claim a deny.
    AlreadyDispatched {
        dispatch_id: String,
        op: BoundaryOp,
        dispatched_at_ms: u64,
    },
}

/// Verdict at a Host authority boundary under an optional deny ceiling.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CeilingVerdict {
    /// No active ceiling, or the op is outside the denied set.
    Allow,
    /// Ceiling refuses the op. Caller must fail closed.
    Deny {
        op: BoundaryOp,
        ceiling_ref: String,
        epochs: EpochTriple,
        code: &'static str,
    },
    /// Prior dispatch already left Host — report accurately, do not rewrite.
    AlreadyDispatched {
        dispatch_id: String,
        op: BoundaryOp,
        dispatched_at_ms: u64,
    },
    /// Presented epochs do not match the durable ceiling (stale handle).
    StaleEpochs {
        presented: EpochTriple,
        expected: EpochTriple,
        code: &'static str,
    },
}

impl CeilingVerdict {
    #[must_use]
    pub const fn permits_new_dispatch(&self) -> bool {
        matches!(self, Self::Allow)
    }

    #[must_use]
    pub const fn code(&self) -> Option<&'static str> {
        match self {
            Self::Allow => None,
            Self::Deny { code, .. } | Self::StaleEpochs { code, .. } => Some(*code),
            Self::AlreadyDispatched { .. } => Some("already_dispatched"),
        }
    }
}

/// Evaluate a deny ceiling at a Host authority boundary.
///
/// Order is load-bearing:
/// 1. Already-dispatched work is reported first (never rewritten as deny).
/// 2. Absent ceiling ⇒ allow (browser-local / Host-optional paths).
/// 3. Epoch mismatch ⇒ stale (fail closed).
/// 4. Denied op ⇒ deny; otherwise allow.
#[must_use]
pub fn evaluate_deny_ceiling(
    ceiling: Option<&DenyCeiling>,
    op: BoundaryOp,
    dispatch: &DispatchState,
    presented_epochs: Option<EpochTriple>,
) -> CeilingVerdict {
    if let DispatchState::AlreadyDispatched {
        dispatch_id,
        op: dispatched_op,
        dispatched_at_ms,
    } = dispatch
    {
        return CeilingVerdict::AlreadyDispatched {
            dispatch_id: dispatch_id.clone(),
            op: *dispatched_op,
            dispatched_at_ms: *dispatched_at_ms,
        };
    }

    let Some(ceiling) = ceiling else {
        return CeilingVerdict::Allow;
    };

    if let Some(presented) = presented_epochs {
        if !presented.matches(ceiling.epochs) {
            return CeilingVerdict::StaleEpochs {
                presented,
                expected: ceiling.epochs,
                code: "stale_duress_epochs",
            };
        }
    } else {
        // An active independent-authority ceiling requires bound epochs.
        return CeilingVerdict::StaleEpochs {
            presented: EpochTriple {
                policy_epoch: 0,
                key_epoch: 0,
                incident_epoch: 0,
            },
            expected: ceiling.epochs,
            code: "missing_duress_epochs",
        };
    }

    if ceiling.denies(op) {
        return CeilingVerdict::Deny {
            op,
            ceiling_ref: ceiling.ceiling_ref.clone(),
            epochs: ceiling.epochs,
            code: "duress_deny_ceiling",
        };
    }

    CeilingVerdict::Allow
}

/// Convenience: map domain op + evaluate in one step.
#[must_use]
pub fn evaluate_authority_boundary(
    ceiling: Option<&DenyCeiling>,
    authority_op: AuthorityOperation,
    dispatch: &DispatchState,
    presented_epochs: Option<EpochTriple>,
) -> CeilingVerdict {
    match BoundaryOp::from_authority_operation(authority_op) {
        Some(op) => evaluate_deny_ceiling(ceiling, op, dispatch, presented_epochs),
        None => {
            // Out-of-scope ops: still surface already-dispatched accurately.
            if let DispatchState::AlreadyDispatched {
                dispatch_id,
                op,
                dispatched_at_ms,
            } = dispatch
            {
                CeilingVerdict::AlreadyDispatched {
                    dispatch_id: dispatch_id.clone(),
                    op: *op,
                    dispatched_at_ms: *dispatched_at_ms,
                }
            } else {
                CeilingVerdict::Allow
            }
        }
    }
}
