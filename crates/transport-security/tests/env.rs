//! Deployment-plane environment loaders (CONTRACT §5), over a lookup so the
//! process environment is never touched.

use std::collections::HashMap;

use opensesame_domain::transport::{TlsVersion, TransportPolicy, TrustProfileKind};
use opensesame_transport_security::env::{
    load_crl_file_from, load_identity_from, load_min_version_from, load_server_expectation_from,
    load_trust_from, ServerExpectation,
};
use opensesame_transport_security::{NativeIdentitySpec, NativeTrustSpec, TransportEnv};

fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let map: HashMap<String, String> = pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    move |name: &str| map.get(name).cloned()
}

#[test]
fn identity_sources_are_explicit() {
    assert_eq!(load_identity_from("P", &lookup(&[])).unwrap(), None);
    let pem = lookup(&[
        ("P_IDENTITY_SOURCE", "pem"),
        ("P_CERT_FILE", "/c.pem"),
        ("P_KEY_FILE", "/k.pem"),
    ]);
    assert_eq!(
        load_identity_from("P", &pem).unwrap(),
        Some(NativeIdentitySpec::PemFiles {
            cert: "/c.pem".into(),
            key: "/k.pem".into()
        })
    );
    assert!(load_identity_from(
        "P",
        &lookup(&[("P_IDENTITY_SOURCE", "pem"), ("P_CERT_FILE", "/c.pem")])
    )
    .is_err());
    let managed = lookup(&[
        ("P_IDENTITY_SOURCE", "managed"),
        ("P_MANAGED_CERTIFICATE_ID", "cert-1"),
    ]);
    assert_eq!(
        load_identity_from("P", &managed).unwrap(),
        Some(NativeIdentitySpec::ManagedCertificate {
            certificate_id: "cert-1".into()
        })
    );
    let spiffe = lookup(&[
        ("P_IDENTITY_SOURCE", "spiffe"),
        ("P_SPIFFE_ID", "spiffe://d/w"),
        ("OPENSESAME_SPIFFE_ENDPOINT_SOCKET", "/run/spire/api.sock"),
    ]);
    assert_eq!(
        load_identity_from("P", &spiffe).unwrap(),
        Some(NativeIdentitySpec::Spiffe {
            spiffe_id: "spiffe://d/w".into(),
            endpoint_socket: "/run/spire/api.sock".into()
        })
    );
    assert!(
        load_identity_from(
            "P",
            &lookup(&[
                ("P_IDENTITY_SOURCE", "spiffe"),
                ("P_SPIFFE_ID", "spiffe://d/w")
            ])
        )
        .is_err(),
        "no socket"
    );
    assert!(load_identity_from("P", &lookup(&[("P_IDENTITY_SOURCE", "auto")])).is_err());
    assert_eq!(
        load_identity_from("P", &lookup(&[("P_IDENTITY_SOURCE", "  ")])).unwrap(),
        None
    );
}

#[test]
fn trust_kinds_are_explicit() {
    assert_eq!(load_trust_from("P", &lookup(&[])).unwrap(), None);
    let private = lookup(&[
        ("P_TRUST_FILE", "/ca.pem"),
        ("P_TRUST_KIND", "private_root"),
    ]);
    assert_eq!(
        load_trust_from("P", &private).unwrap(),
        Some(NativeTrustSpec::PemFile {
            path: "/ca.pem".into(),
            kind: TrustProfileKind::PrivateRoot
        })
    );
    let web = lookup(&[("P_TRUST_FILE", "/ca.pem"), ("P_TRUST_KIND", "webpki_dns")]);
    assert_eq!(
        load_trust_from("P", &web).unwrap(),
        Some(NativeTrustSpec::PemFile {
            path: "/ca.pem".into(),
            kind: TrustProfileKind::WebPkiDns
        })
    );
    assert!(
        load_trust_from("P", &lookup(&[("P_TRUST_FILE", "/ca.pem")])).is_err(),
        "kind is required"
    );
    assert!(
        load_trust_from("P", &lookup(&[("P_TRUST_KIND", "private_root")])).is_err(),
        "file is required"
    );
    let spiffe = lookup(&[
        ("P_TRUST_KIND", "spiffe_trust_domain"),
        ("P_TRUST_DOMAIN", "example.org"),
        ("OPENSESAME_SPIFFE_ENDPOINT_SOCKET", "/s"),
    ]);
    assert_eq!(
        load_trust_from("P", &spiffe).unwrap(),
        Some(NativeTrustSpec::SpiffeTrustDomain {
            trust_domain: "example.org".into(),
            endpoint_socket: "/s".into()
        })
    );
    assert!(load_trust_from(
        "P",
        &lookup(&[
            ("P_TRUST_KIND", "spiffe_trust_domain"),
            ("P_TRUST_DOMAIN", "example.org")
        ])
    )
    .is_err());
    assert!(load_trust_from("P", &lookup(&[("P_TRUST_KIND", "system")])).is_err());
}

#[test]
fn client_expectation_is_exactly_one() {
    assert_eq!(
        load_server_expectation_from("P", &lookup(&[])).unwrap(),
        None
    );
    assert_eq!(
        load_server_expectation_from("P", &lookup(&[("P_SERVER_NAME", "Host.Internal")])).unwrap(),
        Some(ServerExpectation::Dns("host.internal".into()))
    );
    assert_eq!(
        load_server_expectation_from("P", &lookup(&[("P_SERVER_SPIFFE_ID", "spiffe://d/w")]))
            .unwrap(),
        Some(ServerExpectation::SpiffeId("spiffe://d/w".into()))
    );
    assert!(load_server_expectation_from(
        "P",
        &lookup(&[
            ("P_SERVER_NAME", "h"),
            ("P_SERVER_SPIFFE_ID", "spiffe://d/w")
        ])
    )
    .is_err());
}

#[test]
fn min_version_defaults_to_13_and_rejects_older() {
    assert_eq!(
        load_min_version_from("P", &lookup(&[])).unwrap(),
        TlsVersion::Tls13
    );
    assert_eq!(
        load_min_version_from("P", &lookup(&[("P_MIN_VERSION", "1.3")])).unwrap(),
        TlsVersion::Tls13
    );
    assert_eq!(
        load_min_version_from("P", &lookup(&[("P_MIN_VERSION", "1.2")])).unwrap(),
        TlsVersion::Tls12
    );
    assert!(load_min_version_from("P", &lookup(&[("P_MIN_VERSION", "1.1")])).is_err());
    assert!(load_min_version_from("P", &lookup(&[("P_MIN_VERSION", "1.0")])).is_err());
    assert_eq!(
        load_crl_file_from("P", &lookup(&[("P_CRL_FILE", "/crl.pem")])),
        Some("/crl.pem".into())
    );
}

#[test]
fn common_env_parses_listen_and_policy() {
    let env = TransportEnv::from_lookup(&lookup(&[
        ("OPENSESAME_TLS_LISTEN", "127.0.0.1:8443"),
        ("OPENSESAME_TLS_POLICY", "mtls_required"),
        ("OPENSESAME_SERVICE_BINDINGS_FILE", "/b.json"),
    ]))
    .unwrap();
    assert_eq!(env.listen, Some("127.0.0.1:8443".parse().unwrap()));
    assert_eq!(env.policy, Some(TransportPolicy::MtlsRequired));
    assert_eq!(env.service_bindings_file, Some("/b.json".into()));
    assert_eq!(env.spiffe_endpoint_socket, None);
    assert!(
        TransportEnv::from_lookup(&lookup(&[("OPENSESAME_TLS_POLICY", "existing_local")])).is_err(),
        "not a TLS listener policy"
    );
    assert!(TransportEnv::from_lookup(&lookup(&[("OPENSESAME_TLS_LISTEN", "8443")])).is_err());
    assert_eq!(
        TransportEnv::from_lookup(&lookup(&[])).unwrap(),
        TransportEnv::default()
    );
}

#[test]
fn pem_identity_reads_from_disk_and_refuses_missing_files() {
    use opensesame_transport_security::testkit::{tempdir, DisposableCa};
    let ca = DisposableCa::new("root");
    let leaf = ca.issue_server("localhost");
    let dir = tempdir();
    let (cert, key) = leaf.write_to(dir.path());
    let identity = opensesame_transport_security::env::read_pem_identity(&cert, &key).unwrap();
    assert_eq!(identity.leaf_thumbprint_sha256(), leaf.thumbprint);
    assert!(opensesame_transport_security::env::read_pem_identity(
        &cert,
        &dir.path().join("missing.pem")
    )
    .is_err());
}
