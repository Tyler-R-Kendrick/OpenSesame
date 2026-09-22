//! Transport policy, identity-source, custody, and trust-profile vocabulary.

use super::error::TransportError;
use serde::{Deserialize, Serialize};

/// What a listener or client requires of the transport. Never a boolean and
/// never "auto": `ExistingLocal` is a supported profile, not a fallback.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum TransportPolicy {
    ExistingLocal,
    ServerTls,
    MtlsRequired,
    TrustedIngress,
}

impl TransportPolicy {
    /// True when this policy authenticates the client with a certificate.
    #[must_use]
    pub const fn authenticates_client(self) -> bool {
        matches!(self, Self::MtlsRequired | Self::TrustedIngress)
    }

    /// Refuse to move from a policy that authenticates the client to one that
    /// does not (EXPLICIT-ENFORCEMENT: never downgrade).
    ///
    /// # Errors
    ///
    /// `PolicyDowngradeRefused` when `to` is weaker than `self`.
    pub fn transition_to(self, to: Self) -> Result<Self, TransportError> {
        if self.authenticates_client() && !to.authenticates_client() {
            return Err(TransportError::PolicyDowngradeRefused);
        }
        Ok(to)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum TlsVersion {
    Tls12,
    Tls13,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum IdentitySourceKind {
    PemFiles,
    ManagedCertificate,
    SpiffeWorkloadApi,
    BrowserManaged,
}

/// Where the private key actually lives. Truthful, never aspirational: the
/// Workload API hands key bytes to the workload, and a browser-managed
/// certificate's key is the browser's or the OS's, never the vault's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Custody {
    NativeFileExportable,
    HostSealedExportableToHost,
    WorkloadApiDelivered,
    BrowserExternal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum TrustProfileKind {
    WebPkiDns,
    PrivateRoot,
    SpiffeTrustDomain,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum EvidenceSource {
    DirectTls,
    LocalIpc,
    TrustedIngressAssertion,
}

/// Maximum byte length of a reference name.
pub const MAX_REF_NAME_BYTES: usize = 64;

/// `^[a-z0-9][a-z0-9._-]{0,63}$`
fn validate_ref_name(kind: &str, name: &str) -> Result<(), TransportError> {
    let bytes = name.as_bytes();
    let head_ok = bytes
        .first()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    let tail_ok = bytes[1.min(bytes.len())..]
        .iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-'));
    if head_ok && tail_ok && bytes.len() <= MAX_REF_NAME_BYTES {
        Ok(())
    } else {
        Err(TransportError::malformed(format!(
            "{kind}: name must match ^[a-z0-9][a-z0-9._-]{{0,63}}$"
        )))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct RefWire {
    name: String,
}

macro_rules! reference {
    ($(#[$doc:meta])* $name:ident, $kind:literal) => {
        $(#[$doc])*
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case", deny_unknown_fields, try_from = "RefWire")]
        pub struct $name {
            pub name: String,
        }

        impl $name {
            /// Build a validated reference.
            ///
            /// # Errors
            ///
            /// `MalformedConfiguration` when the name is not
            /// `^[a-z0-9][a-z0-9._-]{0,63}$`.
            pub fn new(name: impl Into<String>) -> Result<Self, TransportError> {
                let name = name.into();
                validate_ref_name($kind, &name)?;
                Ok(Self { name })
            }

            /// Re-check a reference that may have been built by hand.
            ///
            /// # Errors
            ///
            /// As [`Self::new`].
            pub fn validate(&self) -> Result<(), TransportError> {
                validate_ref_name($kind, &self.name)
            }
        }

        impl TryFrom<RefWire> for $name {
            type Error = TransportError;
            fn try_from(wire: RefWire) -> Result<Self, TransportError> {
                Self::new(wire.name)
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.name)
            }
        }
    };
}

reference!(
    /// Public reference to an operator-registered identity. Never a path,
    /// socket, or URL — the deployment plane resolves the name.
    IdentitySourceRef,
    "identity_source_ref"
);

reference!(
    /// Public reference to an operator-registered trust bundle.
    TrustProfileRef,
    "trust_profile_ref"
);
