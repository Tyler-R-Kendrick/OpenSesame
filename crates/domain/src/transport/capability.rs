//! Honest capability discovery. "Client presents a certificate" and "server
//! enforces certificates" are different facts; browser vault-key injection is
//! impossible and is reported as such by construction.

use super::error::TransportError;
use serde::{Deserialize, Serialize};

/// Longest reason string accepted.
pub const MAX_REASON_BYTES: usize = 512;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum CapabilityOutcome {
    Supported,
    Unsupported { reason: String },
    ExternalProvisioningRequired { reason: String },
}

impl CapabilityOutcome {
    #[must_use]
    pub const fn is_supported(&self) -> bool {
        matches!(self, Self::Supported)
    }

    /// Unsupported with a bounded, non-secret reason.
    #[must_use]
    pub fn unsupported(reason: impl Into<String>) -> Self {
        Self::Unsupported {
            reason: reason.into(),
        }
    }

    fn validate(&self, field: &str) -> Result<(), TransportError> {
        match self {
            Self::Supported => Ok(()),
            Self::Unsupported { reason } | Self::ExternalProvisioningRequired { reason } => {
                if reason.is_empty() || reason.len() > MAX_REASON_BYTES {
                    Err(TransportError::malformed(format!(
                        "{field}: reason must be 1..={MAX_REASON_BYTES} bytes"
                    )))
                } else {
                    Ok(())
                }
            }
        }
    }
}

const BROWSER_KEY_INJECTION_REASON: &str =
    "a browser cannot attach a vault-held key to its TLS handshake; certificates a browser presents are provisioned outside the app";

/// The one and only value `TransportCapabilities::browser_vault_key_injection`
/// may hold. Every constructor uses it and deserialization refuses anything
/// else (BROWSER-BOUNDARY).
#[must_use]
pub fn browser_vault_key_injection() -> CapabilityOutcome {
    CapabilityOutcome::unsupported(BROWSER_KEY_INJECTION_REASON)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    rename_all = "snake_case",
    deny_unknown_fields,
    try_from = "CapabilitiesWire"
)]
pub struct TransportCapabilities {
    pub native_pem: CapabilityOutcome,
    pub managed_certificate: CapabilityOutcome,
    pub spiffe_workload_api: CapabilityOutcome,
    pub browser_managed_external: CapabilityOutcome,
    /// Always `Unsupported`.
    pub browser_vault_key_injection: CapabilityOutcome,
    /// This side can present a client certificate on outbound connections.
    pub client_presents_certificate: bool,
    /// This side refuses inbound connections without a trusted client
    /// certificate. A successful authenticated connection never proves this.
    pub server_enforces_certificate: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
struct CapabilitiesWire {
    native_pem: CapabilityOutcome,
    managed_certificate: CapabilityOutcome,
    spiffe_workload_api: CapabilityOutcome,
    browser_managed_external: CapabilityOutcome,
    browser_vault_key_injection: CapabilityOutcome,
    client_presents_certificate: bool,
    server_enforces_certificate: bool,
}

impl TryFrom<CapabilitiesWire> for TransportCapabilities {
    type Error = TransportError;
    fn try_from(w: CapabilitiesWire) -> Result<Self, TransportError> {
        let value = Self {
            native_pem: w.native_pem,
            managed_certificate: w.managed_certificate,
            spiffe_workload_api: w.spiffe_workload_api,
            browser_managed_external: w.browser_managed_external,
            browser_vault_key_injection: w.browser_vault_key_injection,
            client_presents_certificate: w.client_presents_certificate,
            server_enforces_certificate: w.server_enforces_certificate,
        };
        value.validate()?;
        Ok(value)
    }
}

impl TransportCapabilities {
    /// A native (Rust or Node) runtime's capabilities. Browser-only outcomes
    /// are fixed: external browser custody is somebody else's provisioning,
    /// and vault-key injection is impossible.
    #[must_use]
    pub fn native(
        native_pem: CapabilityOutcome,
        managed_certificate: CapabilityOutcome,
        spiffe_workload_api: CapabilityOutcome,
        client_presents_certificate: bool,
        server_enforces_certificate: bool,
    ) -> Self {
        Self {
            native_pem,
            managed_certificate,
            spiffe_workload_api,
            browser_managed_external: CapabilityOutcome::unsupported(
                "a native runtime has no browser certificate store to consume",
            ),
            browser_vault_key_injection: browser_vault_key_injection(),
            client_presents_certificate,
            server_enforces_certificate,
        }
    }

    /// The static PWA's capabilities: it can consume an externally
    /// provisioned browser certificate and nothing else, and it enforces
    /// nothing.
    #[must_use]
    pub fn browser() -> Self {
        let no_native = |what: &str| {
            CapabilityOutcome::unsupported(format!(
                "{what} needs a native runtime; the static app has none"
            ))
        };
        Self {
            native_pem: no_native("a PEM identity"),
            managed_certificate: no_native("a managed certificate"),
            spiffe_workload_api: no_native("the SPIFFE Workload API"),
            browser_managed_external: CapabilityOutcome::ExternalProvisioningRequired {
                reason: "the browser or OS must hold the certificate; the app only selects a remote profile that expects one".to_owned(),
            },
            browser_vault_key_injection: browser_vault_key_injection(),
            client_presents_certificate: false,
            server_enforces_certificate: false,
        }
    }

    /// Reject a hand-built value that claims the impossible.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` when `browser_vault_key_injection` is not
    /// `Unsupported` or a reason is empty or oversized.
    pub fn validate(&self) -> Result<(), TransportError> {
        if !matches!(
            self.browser_vault_key_injection,
            CapabilityOutcome::Unsupported { .. }
        ) {
            return Err(TransportError::malformed(
                "browser_vault_key_injection: must be unsupported",
            ));
        }
        self.native_pem.validate("native_pem")?;
        self.managed_certificate.validate("managed_certificate")?;
        self.spiffe_workload_api.validate("spiffe_workload_api")?;
        self.browser_managed_external
            .validate("browser_managed_external")?;
        self.browser_vault_key_injection
            .validate("browser_vault_key_injection")
    }
}
