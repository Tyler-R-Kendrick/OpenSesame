//! Disposable PKI for the live callout stack: one root, a server leaf for
//! the NATS client listener, a server leaf for the mock Host, and two client
//! leaves — the bridge's and an unrelated worker's (AT-CALLOUT-BRIDGE).
//!
//! Every key is generated in this process and written under a `TempDir` that
//! is deleted when the stack stops. Nothing here is ever committed.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use opensesame_domain::transport::{
    PeerIdentitySelector, TlsVersion, TrustProfileKind, TrustProfileRef,
};
use opensesame_transport_security::testkit::{DisposableCa, IssuedLeaf};
use opensesame_transport_security::{ClientProfile, ServerNamePolicy, TlsIdentity, TrustBundle};

/// The trust profile name both ends of the bridge↔Host hop refer to.
pub const CLIENT_TRUST_PROFILE: &str = "callout-client-ca";
/// The DNS name the mock Host's leaf carries (`localhost` so reqwest
/// resolves it without a custom resolver).
pub const HOST_DNS: &str = "localhost";
/// The DNS name the NATS server's leaf carries.
pub const NATS_DNS: &str = "localhost";
/// The bridge's client identity.
pub const BRIDGE_DNS: &str = "bridge.internal";
/// An unrelated workload's client identity, from the same root.
pub const WORKER_DNS: &str = "worker.internal";

pub struct Pki {
    pub ca: DisposableCa,
    pub host_server: IssuedLeaf,
    pub bridge_client: IssuedLeaf,
    pub worker_client: IssuedLeaf,
    pub nats_cert: PathBuf,
    pub nats_key: PathBuf,
}

impl Pki {
    /// Generate everything and write the files nats-server needs into `dir`.
    ///
    /// # Panics
    ///
    /// When the temporary files cannot be written.
    #[must_use]
    pub fn generate(dir: &Path) -> Self {
        let ca = DisposableCa::new("mtls-callout-live");
        let host_server = ca.issue_server(HOST_DNS);
        let nats_server = ca.issue_server(NATS_DNS);
        let bridge_client = ca.issue_client(PeerIdentitySelector::DnsName(BRIDGE_DNS.into()));
        let worker_client = ca.issue_client(PeerIdentitySelector::DnsName(WORKER_DNS.into()));
        let tls_dir = dir.join("nats-tls");
        std::fs::create_dir_all(&tls_dir).expect("nats tls dir");
        let (nats_cert, nats_key) = nats_server.write_to(&tls_dir);
        Self {
            ca,
            host_server,
            bridge_client,
            worker_client,
            nats_cert,
            nats_key,
        }
    }

    /// The bundle a peer of this root is verified against.
    ///
    /// # Panics
    ///
    /// Never: the profile name and the PEM are both well formed.
    #[must_use]
    pub fn trust(&self) -> TrustBundle {
        TrustBundle::from_pem(
            TrustProfileRef::new(CLIENT_TRUST_PROFILE).expect("profile name"),
            TrustProfileKind::PrivateRoot,
            &self.ca.root_pem(),
        )
        .expect("trust bundle")
    }

    /// A client profile toward a server of this root, optionally presenting
    /// `identity`.
    #[must_use]
    pub fn client_profile(&self, dns: &str, identity: Option<Arc<TlsIdentity>>) -> ClientProfile {
        ClientProfile {
            server_trust: self.trust(),
            server_name: ServerNamePolicy::Dns(dns.to_owned()),
            identity,
            min_version: TlsVersion::Tls13,
        }
    }

    /// The bridge's client profile toward the mock Host.
    #[must_use]
    pub fn bridge_to_host(&self) -> ClientProfile {
        self.client_profile(HOST_DNS, Some(Arc::new(self.bridge_client.identity())))
    }

    /// A worker's client profile toward the mock Host: a valid certificate
    /// from the same root that is not the bridge's.
    #[must_use]
    pub fn worker_to_host(&self) -> ClientProfile {
        self.client_profile(HOST_DNS, Some(Arc::new(self.worker_client.identity())))
    }
}
