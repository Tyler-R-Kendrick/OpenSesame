//! Narrow custody access for TLS consumers (ADR 0075 §custody, ADR 0130
//! LIFE-CUSTODY).
//!
//! [`tls_identity_for`] is the one path by which a managed private key is
//! opened for *use* rather than for a human-gated reveal. It opens the sealed
//! blob only when every ownership fact lines up — the row is in the scoped
//! tenant, the host still holds the key (`is_in_custody`), the certificate
//! was issued for the purpose asked, and the key signs for the retained leaf
//! (`TlsIdentity::from_pem` refuses a mismatch) — and then hands back a
//! [`TlsIdentity`], whose key lives inside the TLS provider's signing object
//! and whose `Debug` prints nothing of it. No PEM string leaves this module;
//! the function is `pub(crate)` and nothing routes it to an agent surface.
//!
//! [`crate::managed_certs::reveal_managed_key`] is untouched: that one is
//! human-only and returns PEM on purpose. The two must never be merged.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use opensesame_connection_broker::crypto::{open_scoped, SealedBlob};
use opensesame_domain::OrganizationId;
use opensesame_storage::{seal_scopes, StoredManagedCertificate};
use opensesame_transport_security::{SecretBytes, TlsIdentity};

use crate::app_state::AppState;
use crate::managed_certs::{self, CustodyError, KEY_ID};

/// How a transport consumer intends to use a managed identity. Recorded in
/// the certificate's metadata at issuance and checked on every resolve.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum TransportPurpose {
    /// The Host's own secure listener (server + client EKU).
    Listener,
    /// The Host as a client toward the Identity mapping endpoint.
    IdentityMappingClient,
    /// A `ConnectionRef`-bound upstream connector (client EKU).
    UpstreamConnector,
    /// The task-bus / NATS client.
    NatsClient,
    /// The worker's client identity.
    WorkerClient,
}

impl TransportPurpose {
    pub const ALL: [Self; 5] = [
        Self::Listener,
        Self::IdentityMappingClient,
        Self::UpstreamConnector,
        Self::NatsClient,
        Self::WorkerClient,
    ];

    /// Frozen wire name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Listener => "listener",
            Self::IdentityMappingClient => "identity_mapping_client",
            Self::UpstreamConnector => "upstream_connector",
            Self::NatsClient => "nats_client",
            Self::WorkerClient => "worker_client",
        }
    }

    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.as_str() == raw)
    }

    /// Whether the identity is presented as a TLS *server*.
    #[must_use]
    pub const fn is_listener(self) -> bool {
        matches!(self, Self::Listener)
    }
}

/// Counts every sealed-key open this process performed for TLS use. Tests
/// assert a refused resolve leaves it unchanged (AT-CUSTODY-SOURCE): the
/// ownership checks run *before* the blob is touched.
pub(crate) static UNSEALS: AtomicU64 = AtomicU64::new(0);

/// The public leaf PEM retained on a transport certificate's row.
#[must_use]
pub fn retained_leaf_pem(row: &StoredManagedCertificate) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(&row.metadata_json)
        .ok()?
        .get("leaf_pem")?
        .as_str()
        .map(str::to_owned)
}

/// The purpose a transport certificate was issued for, if any was recorded.
#[must_use]
pub fn recorded_purpose(row: &StoredManagedCertificate) -> Option<TransportPurpose> {
    managed_certs::transport_metadata(row)?
        .get("purpose")?
        .as_str()
        .and_then(TransportPurpose::parse)
}

/// Whether the certificate's identity source is a Workload API stream, which
/// this host must never renew or unseal on its own (ADR 0130: a SPIFFE source
/// owns its snapshots).
#[must_use]
pub fn is_spiffe_sourced(row: &StoredManagedCertificate) -> bool {
    managed_certs::transport_metadata(row)
        .and_then(|t| t.get("source").and_then(|s| s.as_str()).map(str::to_owned))
        .is_some_and(|source| source == "spiffe_workload_api")
}

/// Open a managed certificate's key for TLS use, as a [`TlsIdentity`].
///
/// `organization` is the tenant the caller is acting for; `None` means the
/// deployment itself (the Host's own listener and clients), which resolves
/// under the configured `connection_organization`. A certificate that lives
/// under any other tenant is `NotFound` — the row is never read across the
/// scope, and the blob is never opened.
///
/// # Errors
///
/// [`CustodyError::NotFound`] for an unknown or foreign row,
/// [`CustodyError::NotActive`] once revoked/renewed/expired,
/// [`CustodyError::NotInCustody`] when the host no longer holds the key,
/// [`CustodyError::PurposeMismatch`] when the row was issued for another
/// purpose, [`CustodyError::LeafNotRetained`] for a pre-transport row, and
/// [`CustodyError::Mint`] carrying the transport error code when the sealed
/// key does not sign for the leaf or the leaf is outside its window.
pub(crate) async fn tls_identity_for(
    state: &AppState,
    certificate_id: &str,
    purpose: TransportPurpose,
    organization: Option<&OrganizationId>,
) -> Result<Arc<TlsIdentity>, CustodyError> {
    let organization = organization
        .copied()
        .unwrap_or(state.connection_organization)
        .to_string();
    let row = state
        .db
        .get_certificate(&organization, certificate_id)
        .await?
        .ok_or(CustodyError::NotFound)?;
    if row.status != "active" {
        return Err(CustodyError::NotActive);
    }
    if is_spiffe_sourced(&row) {
        return Err(CustodyError::NotInCustody);
    }
    match recorded_purpose(&row) {
        Some(recorded) if recorded == purpose => {}
        Some(_) => return Err(CustodyError::PurposeMismatch),
        // A plain managed certificate (issued before transport issuance
        // existed) is a serverAuth leaf; it may serve a listener and nothing
        // else. Client purposes need an explicit clientAuth issuance.
        None if purpose.is_listener() => {}
        None => return Err(CustodyError::PurposeMismatch),
    }
    let leaf_pem = retained_leaf_pem(&row).ok_or(CustodyError::LeafNotRetained)?;
    let held = state
        .db
        .get_managed_certificate_key(&organization, certificate_id)
        .await?
        .ok_or(CustodyError::NotInCustody)?;
    if held.sealed_key.key_id != KEY_ID {
        return Err(CustodyError::SealingUnavailable);
    }
    let key = state
        .connection_broker
        .config()
        .key()
        .copied()
        .ok_or(CustodyError::SealingUnavailable)?;
    UNSEALS.fetch_add(1, Ordering::SeqCst);
    let plaintext = open_scoped(
        &key,
        seal_scopes::MANAGED_LEAF_KEY,
        certificate_id,
        &organization,
        &SealedBlob {
            ciphertext: held.sealed_key.ciphertext.clone(),
            nonce: held.sealed_key.nonce.clone(),
            aad_digest: held.sealed_key.aad_digest.clone(),
        },
    )
    .map_err(|error| CustodyError::Storage(anyhow::anyhow!("{error}")))?;
    // The key bytes are wrapped immediately and zeroized when the box drops;
    // `from_pem` proves possession against the retained leaf before anything
    // is returned.
    let secret = SecretBytes::new(Box::new(plaintext));
    let mut chain = leaf_pem.into_bytes();
    if let Some(issuer) = &row.chain_pem {
        chain.extend_from_slice(issuer.as_bytes());
    }
    let identity = TlsIdentity::from_pem(&chain, &secret)
        .map_err(|error| CustodyError::Mint(error.code().to_owned()))?;
    let usage = identity.usage();
    let permitted = if purpose.is_listener() {
        usage.permits_server_auth()
    } else {
        usage.permits_client_auth()
    };
    if !permitted {
        return Err(CustodyError::PurposeMismatch);
    }
    Ok(Arc::new(identity))
}

/// The number of sealed-key opens so far (tests).
#[must_use]
pub(crate) fn unseal_count() -> u64 {
    UNSEALS.load(Ordering::SeqCst)
}
