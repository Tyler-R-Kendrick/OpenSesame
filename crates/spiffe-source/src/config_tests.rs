use std::collections::HashMap;
use std::marker::PhantomData;
use std::path::PathBuf;

use super::{SpiffeSourceConfig, ENDPOINT_SOCKET_ENV};

/// Inherent associated consts win over trait ones: `IS_DESERIALIZABLE` is
/// `true` only for types that implement `DeserializeOwned`.
trait NotDeserializable {
    const IS_DESERIALIZABLE: bool = false;
}
impl<T> NotDeserializable for Probe<T> {}
struct Probe<T>(PhantomData<T>);
impl<T: serde::de::DeserializeOwned> Probe<T> {
    #[allow(dead_code)]
    const IS_DESERIALIZABLE: bool = true;
}

/// The socket path must never arrive through JSON, a header, or a body:
/// the config type does not implement `Deserialize`. `HashMap` is the
/// control that proves the probe detects `Deserialize` when it is there.
#[test]
fn config_cannot_be_deserialized_from_any_wire_format() {
    let config_probe = std::hint::black_box(Probe::<SpiffeSourceConfig>::IS_DESERIALIZABLE);
    let control_probe = std::hint::black_box(Probe::<HashMap<String, String>>::IS_DESERIALIZABLE);
    assert!(!config_probe);
    assert!(control_probe);
}

#[test]
fn config_has_no_wire_constructor_and_no_public_fields() {
    let cfg = SpiffeSourceConfig::deployment_plane("spiffe://td.test/a", "/run/s.sock").unwrap();
    // Everything observable goes through getters; the socket is only ever a path.
    assert!(cfg.endpoint_socket().is_absolute());
    assert_eq!(cfg.trust_domain(), "td.test");
}

#[test]
fn deployment_plane_accepts_only_absolute_socket_paths() {
    let ok =
        SpiffeSourceConfig::deployment_plane("spiffe://td.test/a", "/run/spire/api.sock").unwrap();
    assert_eq!(ok.spiffe_id(), "spiffe://td.test/a");
    assert_eq!(ok.trust_domain(), "td.test");
    assert_eq!(ok.endpoint_socket(), PathBuf::from("/run/spire/api.sock"));
    for bad in [
        "run/spire/api.sock",
        "unix:///run/spire/api.sock",
        "unix:/run/spire/api.sock",
        "tcp://127.0.0.1:8081",
        "tcp:127.0.0.1:8081",
        "https://spire.example/api",
        "",
    ] {
        let err = SpiffeSourceConfig::deployment_plane("spiffe://td.test/a", bad).unwrap_err();
        assert_eq!(err.code(), "spiffe_config", "{bad}: {err}");
    }
}

#[test]
fn deployment_plane_requires_a_canonical_workload_spiffe_id() {
    for bad in [
        "spiffe://td.test",
        "spiffe://td.test/",
        "spiffe://TD.test/a",
        "spiffe://td.test/%61",
        "spiffe://td.test/a/../b",
        "spiffe://td.test/a?x=1",
        "https://td.test/a",
        "spiffe://tᏧ.test/a",
        "",
    ] {
        let err = SpiffeSourceConfig::deployment_plane(bad, "/run/s.sock").unwrap_err();
        assert_eq!(err.code(), "spiffe_config", "{bad}");
    }
}

#[test]
fn env_loader_reads_only_the_named_prefix_and_the_shared_socket_var() {
    let env: HashMap<&str, &str> = HashMap::from([
        ("OPENSESAME_TLS_IDENTITY_SOURCE", "spiffe"),
        ("OPENSESAME_TLS_SPIFFE_ID", " spiffe://td.test/gateway "),
        (ENDPOINT_SOCKET_ENV, "/run/spire/api.sock"),
        ("SPIFFE_ENDPOINT_SOCKET", "unix:///attacker/api.sock"),
    ]);
    let lookup = |name: &str| env.get(name).map(|v| (*v).to_owned());
    let cfg = SpiffeSourceConfig::from_env_with("OPENSESAME_TLS", lookup)
        .unwrap()
        .expect("configured");
    assert_eq!(cfg.spiffe_id(), "spiffe://td.test/gateway");
    assert_eq!(cfg.endpoint_socket(), PathBuf::from("/run/spire/api.sock"));
    assert!(
        SpiffeSourceConfig::from_env_with("OPENSESAME_NATS_TLS", lookup)
            .unwrap()
            .is_none()
    );
}

#[test]
fn env_loader_ignores_the_sdk_default_variable() {
    let env: HashMap<&str, &str> = HashMap::from([
        ("P_IDENTITY_SOURCE", "spiffe"),
        ("P_SPIFFE_ID", "spiffe://td.test/a"),
        ("SPIFFE_ENDPOINT_SOCKET", "unix:///run/spire/api.sock"),
    ]);
    let err = SpiffeSourceConfig::from_env_with("P", |n| env.get(n).map(|v| (*v).to_owned()))
        .unwrap_err();
    assert!(err.to_string().contains(ENDPOINT_SOCKET_ENV), "{err}");
}

#[test]
fn env_loader_requires_the_spiffe_id_when_source_is_spiffe() {
    let env: HashMap<&str, &str> = HashMap::from([
        ("P_IDENTITY_SOURCE", "spiffe"),
        (ENDPOINT_SOCKET_ENV, "/run/spire/api.sock"),
    ]);
    let err = SpiffeSourceConfig::from_env_with("P", |n| env.get(n).map(|v| (*v).to_owned()))
        .unwrap_err();
    assert!(err.to_string().contains("P_SPIFFE_ID"), "{err}");
}

#[test]
fn pem_and_managed_sources_are_not_this_source() {
    for other in ["pem", "managed", "", "SPIFFE"] {
        let env: HashMap<&str, &str> = HashMap::from([("P_IDENTITY_SOURCE", other)]);
        assert!(
            SpiffeSourceConfig::from_env_with("P", |n| env.get(n).map(|v| (*v).to_owned()))
                .unwrap()
                .is_none(),
            "{other:?}"
        );
    }
}

#[test]
fn native_spec_only_yields_a_source_for_the_spiffe_variant() {
    use opensesame_transport_security::NativeIdentitySpec;
    let spiffe = NativeIdentitySpec::Spiffe {
        spiffe_id: "spiffe://td.test/a".into(),
        endpoint_socket: PathBuf::from("/run/spire/api.sock"),
    };
    assert_eq!(
        SpiffeSourceConfig::from_native_spec(&spiffe)
            .unwrap()
            .unwrap()
            .spiffe_id(),
        "spiffe://td.test/a"
    );
    let pem = NativeIdentitySpec::PemFiles {
        cert: PathBuf::from("/etc/c.pem"),
        key: PathBuf::from("/etc/k.pem"),
    };
    assert!(SpiffeSourceConfig::from_native_spec(&pem)
        .unwrap()
        .is_none());
    let bad = NativeIdentitySpec::Spiffe {
        spiffe_id: "spiffe://td.test/a".into(),
        endpoint_socket: PathBuf::from("tcp://127.0.0.1:8081"),
    };
    assert!(SpiffeSourceConfig::from_native_spec(&bad).is_err());
}
