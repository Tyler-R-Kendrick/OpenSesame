//! Every way a sandboxed run can be refused or stopped.
//!
//! The variants are deliberately specific. "Sandbox failed" is useless in a
//! receipt: an operator needs to know whether a guest asked for the
//! filesystem, outran its fuel, or was killed because the authority behind
//! it was revoked mid-run — those are three different incidents.

use opensesame_domain::DomainError;
use thiserror::Error;

use crate::format::GuestFormat;

/// A refusal, a resource stop, or a revocation.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum SandboxError {
    /// The payload is not a wasm core module (see [`GuestFormat::refusal`]).
    #[error("unsupported guest payload ({format}): {reason}")]
    UnsupportedPayload {
        /// What the bytes turned out to be.
        format: &'static str,
        /// Why this host will not run them.
        reason: &'static str,
    },

    /// The guest asked for an import outside the brokered module — the
    /// filesystem, the environment, a socket, a clock, an RNG.
    #[error("ambient capability denied: guest imports `{module}::{name}` ({kind})")]
    AmbientImport {
        /// The import's module name, verbatim from the guest.
        module: String,
        /// The import's field name, verbatim from the guest.
        name: String,
        /// The ambient surface it would have reached.
        kind: &'static str,
    },

    /// The guest imports a brokered function the grant chain did not grant.
    #[error("brokered capability `{0}` is not in this profile")]
    CapabilityNotGranted(String),

    /// The guest imports a name that does not exist in the brokered module.
    #[error("no such brokered import: `{0}`")]
    UnknownBrokeredImport(String),

    /// The guest wants the host to supply a memory, table, or global.
    /// It may not: a host-supplied memory would sit outside the store limit.
    #[error("guest must define its own {0}; the host supplies none")]
    HostSuppliedState(&'static str),

    /// The guest has no `run` export, or its signature is wrong.
    #[error("guest entry point `{0}` is missing or has the wrong signature")]
    MissingEntryPoint(&'static str),

    /// The guest needs linear memory for a brokered call but exports none.
    #[error("guest exports no `memory`, so no brokered call can pass bytes")]
    MissingMemory,

    /// The grant chain cannot produce a runnable profile.
    #[error("grant chain admits no sandbox profile: {0}")]
    Profile(String),

    /// A grant permitting raw credential export can never back a sandbox.
    #[error("grant permits raw credential export; a sandbox never materializes a secret")]
    RawExportDenied,

    /// The authority behind the run was revoked (before or during it).
    #[error("authority revoked: profile generation {expected}, ledger at {observed}")]
    Revoked {
        /// The generation the profile was minted against.
        expected: u64,
        /// The generation the ledger reports now.
        observed: u64,
    },

    /// The run burned its instruction budget.
    #[error("fuel exhausted")]
    FuelExhausted,

    /// The run outlived its wall-clock deadline.
    #[error("deadline exceeded")]
    DeadlineExceeded,

    /// The guest tried to hold more linear memory than the profile allows.
    #[error("memory limit exceeded")]
    MemoryLimit,

    /// The guest trapped for a reason of its own.
    #[error("guest trap: {0}")]
    Trap(String),

    /// The runtime itself could not be built or the module could not compile.
    #[error("runtime: {0}")]
    Runtime(String),
}

impl SandboxError {
    /// Build the refusal for a payload this host will not run.
    #[must_use]
    pub const fn unsupported(format: GuestFormat) -> Self {
        Self::UnsupportedPayload {
            format: format.as_str(),
            reason: match format.refusal() {
                Some(reason) => reason,
                // A runnable format never reaches here; say so rather than
                // panicking inside a const fn on the refusal path.
                None => "payload is runnable",
            },
        }
    }

    /// Whether the run stopped because a resource ran out rather than
    /// because the guest was refused something.
    ///
    /// Useful at the call site: a budget stop is a candidate for a retry
    /// with a wider grant, a refusal never is.
    #[must_use]
    pub const fn is_budget_stop(&self) -> bool {
        matches!(
            self,
            Self::FuelExhausted | Self::DeadlineExceeded | Self::MemoryLimit
        )
    }
}

impl From<DomainError> for SandboxError {
    fn from(error: DomainError) -> Self {
        match error {
            DomainError::GrantRevoked => Self::Revoked {
                expected: 0,
                observed: 0,
            },
            DomainError::ExportDenied => Self::RawExportDenied,
            other => Self::Profile(other.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SandboxError;
    use crate::format::GuestFormat;
    use opensesame_domain::DomainError;

    #[test]
    fn a_native_payload_refuses_with_its_format_named() {
        let err = SandboxError::unsupported(GuestFormat::Elf);
        let text = err.to_string();
        assert!(text.contains("elf"), "{text}");
        assert!(text.contains("unsandboxed"), "{text}");
        assert!(!err.is_budget_stop());
    }

    #[test]
    fn budget_stops_are_distinguishable_from_refusals() {
        assert!(SandboxError::FuelExhausted.is_budget_stop());
        assert!(SandboxError::DeadlineExceeded.is_budget_stop());
        assert!(SandboxError::MemoryLimit.is_budget_stop());
        assert!(!SandboxError::RawExportDenied.is_budget_stop());
        assert!(!SandboxError::Revoked {
            expected: 1,
            observed: 2
        }
        .is_budget_stop());
    }

    #[test]
    fn a_revoked_grant_does_not_degrade_into_a_generic_profile_error() {
        assert!(matches!(
            SandboxError::from(DomainError::GrantRevoked),
            SandboxError::Revoked { .. }
        ));
        assert_eq!(
            SandboxError::from(DomainError::ExportDenied),
            SandboxError::RawExportDenied
        );
        assert!(matches!(
            SandboxError::from(DomainError::DelegationChainCycle),
            SandboxError::Profile(_)
        ));
    }
}
