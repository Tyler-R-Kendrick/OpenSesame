//! SBOX-BOUNDARY — brokered imports only, decided before the guest runs.
//!
//! The boundary is enforced twice, on purpose.
//!
//! - **At link time**, [`audit_import`] walks the module's declared imports
//!   and refuses anything outside [`crate::BROKERED_MODULE`], anything the
//!   profile did not grant, and any request for host-supplied state. This is
//!   the fence that makes "no ambient authority" a property of the program
//!   rather than a promise about the host: a guest importing `fd_write`
//!   never instantiates, so there is no call to intercept later.
//! - **At call time**, every brokered function re-checks the revocation
//!   fence and the profile's caps before touching the [`Broker`]. Link-time
//!   authority is a snapshot; a run can outlive it.
//!
//! A guest learns nothing from a refusal beyond the fact of it. Brokered
//! calls answer with a small negative [`Refusal`] code and no detail, so a
//! guest cannot use the boundary as an oracle for what exists behind it.

use std::collections::BTreeSet;

use opensesame_domain::{GrantId, OrganizationId};

use crate::capability::{AmbientKind, BrokeredCapability, BROKERED_MODULE};
use crate::error::SandboxError;

/// The kinds of thing a wasm module can import.
///
/// Mirrored from the runtime's own `ExternType` so the rule can be stated
/// and tested without a wasm engine in the room.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportKind {
    /// A function — the only kind a guest may import.
    Function,
    /// A linear memory. Refused: a host-supplied memory sits outside the
    /// store's limiter, so the profile's memory cap would not apply to it.
    Memory,
    /// A table. Refused: host-supplied call targets are host code the guest
    /// chose, which is the opposite of a brokered boundary.
    Table,
    /// A mutable global. Refused: shared mutable state across the boundary.
    Global,
    /// An exception tag. Refused as unknown state.
    Tag,
}

impl ImportKind {
    /// The noun used in the refusal message.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Memory => "memory",
            Self::Table => "table",
            Self::Global => "global",
            Self::Tag => "tag",
        }
    }
}

/// Decide one declared import against a profile's granted capabilities.
///
/// # Errors
///
/// Returns [`SandboxError::AmbientImport`] for anything outside the brokered
/// module, [`SandboxError::UnknownBrokeredImport`] for a name the brokered
/// module does not define, [`SandboxError::CapabilityNotGranted`] for a real
/// capability this chain did not confer, and
/// [`SandboxError::HostSuppliedState`] for a non-function import.
pub fn audit_import(
    module: &str,
    name: &str,
    kind: ImportKind,
    granted: &BTreeSet<BrokeredCapability>,
) -> Result<BrokeredCapability, SandboxError> {
    if module != BROKERED_MODULE {
        return Err(SandboxError::AmbientImport {
            module: module.to_owned(),
            name: name.to_owned(),
            kind: AmbientKind::classify(module, name).as_str(),
        });
    }
    if kind != ImportKind::Function {
        return Err(SandboxError::HostSuppliedState(kind.as_str()));
    }
    let capability = BrokeredCapability::from_import_name(name)
        .ok_or_else(|| SandboxError::UnknownBrokeredImport(name.to_owned()))?;
    if !granted.contains(&capability) {
        return Err(SandboxError::CapabilityNotGranted(name.to_owned()));
    }
    Ok(capability)
}

/// What a guest is told when a brokered call is refused.
///
/// Negative so it cannot be confused with a byte count, and coarse so it
/// cannot be mined: "denied" covers policy, a missing destination, and a
/// broker-side failure alike.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
pub enum Refusal {
    /// The broker said no, for any reason it does not wish to explain.
    Denied = -1,
    /// The guest asked to move more bytes than its budget allows.
    Oversized = -2,
    /// The pointer or length the guest passed is not inside its memory.
    BadPointer = -3,
    /// The guest passed bytes that are not valid UTF-8 where text is required.
    Malformed = -4,
}

impl Refusal {
    /// The value handed back to the guest.
    #[must_use]
    pub const fn code(self) -> i32 {
        self as i32
    }
}

/// Which run is calling, for a broker that needs to decide per tenant.
///
/// Carries identifiers only. A broker that wants the grant itself should
/// look it up; handing the guest's call site a `Grant` would put policy
/// state one deref away from guest-controlled input.
#[derive(Clone, Copy, Debug)]
pub struct RunContext {
    /// The tenant the run belongs to.
    pub organization_id: OrganizationId,
    /// The leaf grant the run is bound to.
    pub leaf_grant_id: GrantId,
    /// The chain root behind it.
    pub root_grant_id: GrantId,
}

/// The host side of the boundary.
///
/// Note what is absent: there is no `get_secret`, no `open`, no `connect`,
/// no way to hand the guest a credential. [`Self::http_fetch`] takes a
/// destination and returns bytes — the implementation injects authorization
/// on this side, exactly as `HostEgress` does for community connectors — and
/// [`Self::token_acquire`] answers with an opaque handle rather than a
/// token, so acquiring one gives the guest nothing it can exfiltrate.
pub trait Broker: Send + Sync {
    /// Accept the run's result. Called at most as often as the guest calls
    /// `emit`; the runtime has already capped the size.
    ///
    /// # Errors
    ///
    /// Returns a [`Refusal`] the guest sees as a negative code.
    fn emit(&self, run: &RunContext, bytes: &[u8]) -> Result<(), Refusal>;

    /// Fetch an authorized destination on the guest's behalf.
    ///
    /// # Errors
    ///
    /// Returns a [`Refusal`] for any destination this run may not reach.
    fn http_fetch(&self, run: &RunContext, destination: &str) -> Result<Vec<u8>, Refusal>;

    /// Sign a digest for a named purpose. The key stays here.
    ///
    /// # Errors
    ///
    /// Returns a [`Refusal`] when the purpose is not one this run may sign for.
    fn sign(&self, run: &RunContext, purpose: &str, digest: &[u8]) -> Result<Vec<u8>, Refusal>;

    /// Acquire a token and return an opaque handle id — never bytes.
    ///
    /// # Errors
    ///
    /// Returns a [`Refusal`] when the scope is outside this run's authority.
    fn token_acquire(&self, run: &RunContext, scope: &str) -> Result<u32, Refusal>;
}

/// A broker that refuses everything.
///
/// The right default for a profile with no capabilities, and the right
/// broker for a test that wants to prove a guest never reached the host.
#[derive(Clone, Copy, Debug, Default)]
pub struct DenyAll;

impl Broker for DenyAll {
    fn emit(&self, _run: &RunContext, _bytes: &[u8]) -> Result<(), Refusal> {
        Err(Refusal::Denied)
    }
    fn http_fetch(&self, _run: &RunContext, _destination: &str) -> Result<Vec<u8>, Refusal> {
        Err(Refusal::Denied)
    }
    fn sign(&self, _run: &RunContext, _purpose: &str, _digest: &[u8]) -> Result<Vec<u8>, Refusal> {
        Err(Refusal::Denied)
    }
    fn token_acquire(&self, _run: &RunContext, _scope: &str) -> Result<u32, Refusal> {
        Err(Refusal::Denied)
    }
}

#[cfg(test)]
mod tests {
    use super::{audit_import, ImportKind, Refusal};
    use crate::capability::{BrokeredCapability, BROKERED_MODULE};
    use crate::error::SandboxError;
    use std::collections::BTreeSet;

    fn granted(caps: &[BrokeredCapability]) -> BTreeSet<BrokeredCapability> {
        caps.iter().copied().collect()
    }

    #[test]
    fn every_ambient_module_is_refused_and_named() {
        let all = granted(&BrokeredCapability::ALL);
        for (module, name, expected_kind) in [
            ("wasi_snapshot_preview1", "fd_write", "filesystem"),
            ("wasi_snapshot_preview1", "sock_connect", "network"),
            ("wasi_snapshot_preview1", "environ_get", "environment"),
            ("wasi_snapshot_preview1", "clock_time_get", "clock"),
            ("wasi_snapshot_preview1", "random_get", "randomness"),
            ("wasi_snapshot_preview1", "proc_exit", "process"),
            ("env", "emit", "unclassified"),
            ("wasi:filesystem/types", "descriptor", "filesystem"),
        ] {
            let refusal = audit_import(module, name, ImportKind::Function, &all)
                .expect_err("ambient import must be refused");
            match refusal {
                SandboxError::AmbientImport { kind, .. } => {
                    assert_eq!(kind, expected_kind, "{module}::{name}");
                }
                other => panic!("{module}::{name} refused as {other:?}"),
            }
        }
    }

    #[test]
    fn a_near_miss_on_the_brokered_module_name_is_still_ambient() {
        let all = granted(&BrokeredCapability::ALL);
        for module in [
            "opensesame:sandbox ",
            "opensesame:sandbox2",
            "Opensesame:sandbox",
            "opensesame:connector",
            "",
        ] {
            assert!(
                audit_import(module, "emit", ImportKind::Function, &all).is_err(),
                "module `{module}` must not pass for the brokered module"
            );
        }
        assert!(audit_import(BROKERED_MODULE, "emit", ImportKind::Function, &all).is_ok());
    }

    #[test]
    fn an_ungranted_capability_is_refused_even_though_it_exists() {
        let only_emit = granted(&[BrokeredCapability::Emit]);
        assert_eq!(
            audit_import(BROKERED_MODULE, "emit", ImportKind::Function, &only_emit),
            Ok(BrokeredCapability::Emit)
        );
        assert_eq!(
            audit_import(
                BROKERED_MODULE,
                "http-fetch",
                ImportKind::Function,
                &only_emit
            ),
            Err(SandboxError::CapabilityNotGranted("http-fetch".into()))
        );
        assert_eq!(
            audit_import(BROKERED_MODULE, "sign", ImportKind::Function, &only_emit),
            Err(SandboxError::CapabilityNotGranted("sign".into()))
        );
    }

    #[test]
    fn an_invented_brokered_name_does_not_exist() {
        let all = granted(&BrokeredCapability::ALL);
        assert_eq!(
            audit_import(BROKERED_MODULE, "get-secret", ImportKind::Function, &all),
            Err(SandboxError::UnknownBrokeredImport("get-secret".into()))
        );
    }

    #[test]
    fn the_host_supplies_no_memory_table_or_global() {
        let all = granted(&BrokeredCapability::ALL);
        for kind in [
            ImportKind::Memory,
            ImportKind::Table,
            ImportKind::Global,
            ImportKind::Tag,
        ] {
            assert_eq!(
                audit_import(BROKERED_MODULE, "emit", kind, &all),
                Err(SandboxError::HostSuppliedState(kind.as_str())),
                "{kind:?}"
            );
        }
    }

    #[test]
    fn an_empty_profile_admits_no_brokered_import_at_all() {
        let nothing = BTreeSet::new();
        for capability in BrokeredCapability::ALL {
            assert!(audit_import(
                BROKERED_MODULE,
                capability.import_name(),
                ImportKind::Function,
                &nothing
            )
            .is_err());
        }
    }

    #[test]
    fn refusal_codes_are_negative_and_distinct() {
        let codes = [
            Refusal::Denied.code(),
            Refusal::Oversized.code(),
            Refusal::BadPointer.code(),
            Refusal::Malformed.code(),
        ];
        assert!(codes.iter().all(|c| *c < 0), "{codes:?}");
        let unique: BTreeSet<_> = codes.iter().collect();
        assert_eq!(unique.len(), codes.len());
    }
}
