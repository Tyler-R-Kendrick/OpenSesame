//! The run's certificate authority: minted when the run starts, held in
//! memory only, and gone when the run's registry entry is dropped.
//!
//! The child trusts this CA through its own trust variables and nothing else
//! does (ADR 0150 §6.1): no system or user trust store is touched, and the
//! upstream half keeps invoke-through's own roots. The key never leaves this
//! struct — [`RunCa::cert_pem`] is the certificate alone, and `Debug` names
//! nothing but the host count.
//!
//! Leaves are minted on demand, one per host the child dials, because the
//! proxy must terminate TLS to *any* host to see a surrogate sent where it
//! should not go: that request is the tripwire. They share one per-run leaf
//! key and are cached per host, up to a bound; past it a leaf is still minted
//! but not kept, so a child dialling endless hosts cannot grow the cache.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, SanType, SerialNumber,
};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::sign::{CertifiedKey, SigningKey, SingleCertAndKey};
use rustls::ServerConfig;

/// Hosts whose leaf is kept for reuse.
const MAX_CACHED_HOSTS: usize = 256;
/// Backdating absorbs a child's clock running slightly behind ours.
const BACKDATE_SECS: u64 = 300;

/// Why a certificate could not be minted. Carries no key material.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CertError {
    #[error("certificate minting failed: {0}")]
    Mint(String),
    #[error("`{0}` is not a host a certificate can name")]
    Host(String),
}

fn mint_err(error: impl std::fmt::Display) -> CertError {
    CertError::Mint(error.to_string())
}

/// One run's CA and its leaf cache.
pub(crate) struct RunCa {
    issuer: Issuer<'static, KeyPair>,
    cert_pem: String,
    leaf_key: KeyPair,
    leaf_signer: Arc<dyn SigningKey>,
    provider: Arc<CryptoProvider>,
    not_before: time::OffsetDateTime,
    not_after: time::OffsetDateTime,
    serial: Mutex<u64>,
    leaves: Mutex<HashMap<String, Arc<ServerConfig>>>,
}

impl std::fmt::Debug for RunCa {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let hosts = self.leaves.lock().map_or(0, |leaves| leaves.len());
        f.debug_struct("RunCa")
            .field("cached_hosts", &hosts)
            .finish_non_exhaustive()
    }
}

fn offset(unix: u64) -> Result<time::OffsetDateTime, CertError> {
    let seconds = i64::try_from(unix).map_err(mint_err)?;
    time::OffsetDateTime::from_unix_timestamp(seconds).map_err(mint_err)
}

impl RunCa {
    /// A fresh CA valid from shortly before `now_unix` for `validity_secs`.
    pub(crate) fn mint(
        run_label: &str,
        now_unix: u64,
        validity_secs: u64,
    ) -> Result<Self, CertError> {
        let not_before = offset(now_unix.saturating_sub(BACKDATE_SECS))?;
        let not_after = offset(now_unix.saturating_add(validity_secs))?;
        let ca_key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(mint_err)?;
        let mut params = CertificateParams::default();
        params.distinguished_name.push(
            DnType::CommonName,
            format!("OpenSesame surrogate proxy {run_label}"),
        );
        // Path length zero: this CA signs leaves and never another CA.
        params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        params.key_usages = vec![
            KeyUsagePurpose::KeyCertSign,
            KeyUsagePurpose::DigitalSignature,
        ];
        params.not_before = not_before;
        params.not_after = not_after;
        params.serial_number = Some(SerialNumber::from(1_u64.to_be_bytes().to_vec()));
        let cert = params.self_signed(&ca_key).map_err(mint_err)?;
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let leaf_key = KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(mint_err)?;
        // The leaf key is held twice for the run's life, both in memory: as
        // rcgen's key (whose public half each leaf certifies) and as rustls's
        // signer. Neither is ever serialized anywhere else.
        let leaf_signer = provider
            .key_provider
            .load_private_key(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
                leaf_key.serialize_der(),
            )))
            .map_err(mint_err)?;
        Ok(Self {
            cert_pem: cert.pem(),
            issuer: Issuer::new(params, ca_key),
            leaf_key,
            leaf_signer,
            provider,
            not_before,
            not_after,
            serial: Mutex::new(1),
            leaves: Mutex::new(HashMap::new()),
        })
    }

    /// The CA certificate, PEM. Public by nature; the key stays here.
    pub(crate) fn cert_pem(&self) -> &str {
        &self.cert_pem
    }

    /// A TLS server config presenting a leaf for `host`, minted on first use.
    pub(crate) fn server_config(&self, host: &str) -> Result<Arc<ServerConfig>, CertError> {
        if let Some(config) = self.cached(host) {
            return Ok(config);
        }
        let config = Arc::new(self.build(host)?);
        if let Ok(mut leaves) = self.leaves.lock() {
            if leaves.len() < MAX_CACHED_HOSTS {
                leaves.insert(host.to_owned(), Arc::clone(&config));
            }
        }
        Ok(config)
    }

    fn cached(&self, host: &str) -> Option<Arc<ServerConfig>> {
        self.leaves.lock().ok()?.get(host).cloned()
    }

    fn next_serial(&self) -> SerialNumber {
        let mut serial = self
            .serial
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *serial += 1;
        SerialNumber::from(serial.to_be_bytes().to_vec())
    }

    fn build(&self, host: &str) -> Result<ServerConfig, CertError> {
        let mut params = CertificateParams::default();
        params.distinguished_name.push(DnType::CommonName, host);
        let san = match host.parse::<IpAddr>() {
            Ok(ip) => SanType::IpAddress(ip),
            Err(_) => SanType::DnsName(
                host.try_into()
                    .map_err(|_| CertError::Host(host.to_owned()))?,
            ),
        };
        params.subject_alt_names = vec![san];
        params.is_ca = IsCa::ExplicitNoCa;
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        params.not_before = self.not_before;
        params.not_after = self.not_after;
        params.serial_number = Some(self.next_serial());
        params.use_authority_key_identifier_extension = true;
        let leaf = params
            .signed_by(&self.leaf_key, &self.issuer)
            .map_err(mint_err)?;
        let chain = vec![leaf.der().clone()];
        let certified = CertifiedKey::new(chain, Arc::clone(&self.leaf_signer));
        let mut config = ServerConfig::builder_with_provider(Arc::clone(&self.provider))
            .with_safe_default_protocol_versions()
            .map_err(mint_err)?
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(SingleCertAndKey::from(certified)));
        // HTTP/1.1 only: the inner request is parsed with hyper's http1
        // server, and a client that insists on h2 fails the handshake rather
        // than reaching anything.
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ca_pem_is_a_certificate_and_never_a_key() {
        let ca = RunCa::mint("run-1", 1_800_000_000, 3600).expect("ca");
        assert!(ca.cert_pem().contains("BEGIN CERTIFICATE"));
        assert!(!ca.cert_pem().contains("PRIVATE KEY"));
        let rendered = format!("{ca:?}");
        assert!(!rendered.contains("PRIVATE"), "{rendered}");
    }

    #[test]
    fn leaves_are_cached_per_host_up_to_the_bound() {
        let ca = RunCa::mint("run-1", 1_800_000_000, 3600).expect("ca");
        let first = ca.server_config("api.github.com").expect("leaf");
        let again = ca.server_config("api.github.com").expect("leaf");
        assert!(Arc::ptr_eq(&first, &again));
        ca.server_config("127.0.0.1")
            .expect("an ip literal gets an ip SAN");
        for i in 0..MAX_CACHED_HOSTS + 4 {
            ca.server_config(&format!("h{i}.example")).expect("leaf");
        }
        assert_eq!(ca.leaves.lock().unwrap().len(), MAX_CACHED_HOSTS);
    }

    #[test]
    fn a_host_no_certificate_can_name_is_refused() {
        let ca = RunCa::mint("run-1", 1_800_000_000, 3600).expect("ca");
        assert!(matches!(
            ca.server_config("bücher.example"),
            Err(CertError::Host(_))
        ));
    }
}
