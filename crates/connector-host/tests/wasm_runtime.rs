//! Runtime tests for the Wasm connector host (ADR 0065 §3).
//!
//! The guest is a hand-authored WAT component implementing the
//! `opensesame:connector` world: `describe` reports id `echo`, and `invoke`
//! returns `Ok([])` for real operations but spins forever for the 4-byte
//! operation `spin` — which is exactly what the fuel and deadline tests need.
#![cfg(feature = "wasm-connectors")]

use std::sync::Arc;
use std::time::Duration;

use opensesame_connector_host::manifest::ConnectorManifest;
use opensesame_connector_host::wasm::{
    EgressRequest, EgressResponse, GuestLimits, HostEgress, WasmConnector,
};
use opensesame_connector_host::{
    opensesame_param_digest, Connector, HostError, HostPolicy, InvokeRequest,
};
use sha2::{Digest, Sha256};

/// A component of the connector world. Layout notes:
/// - `describe` returns a pointer to a connector-info record at offset 64
///   (id "echo" @16, version "1.0.0" @20, empty operations list);
/// - `invoke`'s core signature is the flattened intent (16 params, the
///   `expires-at-unix-ms` u64 at index 13) returning a pointer to a
///   result<list<u8>, invoke-error>; offset 128 is zero bytes = `Ok([])`;
/// - operation length (param index 4) == 4 selects the infinite loop.
const ECHO_WAT: &str = r#"
(component
  (import "opensesame:connector/types@1.0.0" (instance $types
    (export "connection-handle" (type (sub resource)))
  ))
  (alias export $types "connection-handle" (type $conn))

  (core module $m
    (import "host" "drop-connection" (func $drop_conn (param i32)))
    (memory (export "memory") 1)
    (func (export "cabi_realloc") (param i32 i32 i32 i32) (result i32)
      (i32.const 4096))
    (func (export "describe") (result i32) (i32.const 64))
    (func (export "invoke")
      (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i64 i32 i32)
      (result i32)
      ;; A borrowed handle must be relinquished before returning.
      (call $drop_conn (local.get 0))
      (if (i32.eq (local.get 4) (i32.const 4))
        (then (loop $spin (br $spin))))
      (i32.const 128))
    (data (i32.const 16) "echo1.0.0")
    ;; connector-info record: id ptr/len, version ptr/len, operations ptr/len
    (data (i32.const 64) "\10\00\00\00\04\00\00\00\14\00\00\00\05\00\00\00\00\00\00\00\00\00\00\00")
  )
  (canon resource.drop $conn (core func $drop))
  (core instance $i (instantiate $m
    (with "host" (instance (export "drop-connection" (func $drop))))))
  (alias core export $i "memory" (core memory $mem))
  (alias core export $i "cabi_realloc" (core func $realloc))

  (type $info_t (record
    (field "id" string)
    (field "version" string)
    (field "operations" (list string))))
  (export $info "connector-info" (type $info_t))
  (type $intent_t (record
    (field "id" string)
    (field "operation" string)
    (field "resource" string)
    (field "audience" string)
    (field "parameters" (list u8))
    (field "parameters-digest" string)
    (field "expires-at-unix-ms" u64)
    (field "idempotency-key" string)))
  (export $intent "intent" (type $intent_t))
  (type $invoke_error_t (variant
    (case "invalid-input" string)
    (case "unauthorized" string)
    (case "approval-required" string)
    (case "rate-limited" (option u64))
    (case "provider-error" (tuple u16 string))
    (case "transient" string)
    (case "permanent" string)))
  (export $invoke-error "invoke-error" (type $invoke_error_t))

  (func (export "describe") (result $info)
    (canon lift (core func $i "describe") (memory $mem) (realloc $realloc) string-encoding=utf8))

  (func (export "invoke")
    (param "connection" (borrow $conn)) (param "intent" $intent)
    (result (result (list u8) (error $invoke-error)))
    (canon lift (core func $i "invoke") (memory $mem) (realloc $realloc) string-encoding=utf8))
)
"#;

/// A component that reaches for an import outside the connector world.
const FOREIGN_IMPORT_WAT: &str = r#"
(component
  (import "wasi:cli/environment@0.2.0" (instance))
)
"#;

const MANIFEST_TEMPLATE: &str = r"
apiVersion: opensesame.dev/v1alpha1
kind: ConnectorDefinition
metadata:
  id: echo
  version: 1.0.0
  publisher: https://example.com/echo
spec:
  component:
    oci: ghcr.io/example/echo@DIGEST
    witWorld: opensesame:connector/connector@1.0.0
    signaturesRequired: true
  authModes: [brokered_session]
  outbound:
    hosts: [api.example.com]
  operations:
    - id: echo.read
      risk: read
    - id: spin
      risk: read
";

struct RecordingEgress;

impl HostEgress for RecordingEgress {
    fn authorized_request(
        &self,
        _connection_ref: &str,
        _req: EgressRequest,
    ) -> Result<EgressResponse, String> {
        Ok(EgressResponse {
            status: 200,
            headers: vec![],
            body: b"{}".to_vec(),
        })
    }
    fn sign(&self, _purpose: &str, _digest: &[u8]) -> Result<Vec<u8>, String> {
        Ok(vec![0; 32])
    }
    fn oauth_acquire(
        &self,
        _connection_ref: &str,
        _resource: Option<&str>,
        _audience: Option<&str>,
        _scopes: &[String],
    ) -> Result<u32, String> {
        Ok(7)
    }
    fn authenticated_request(
        &self,
        _connection_ref: &str,
        _token_handle: u32,
        _req: EgressRequest,
    ) -> Result<EgressResponse, String> {
        Ok(EgressResponse {
            status: 200,
            headers: vec![],
            body: vec![],
        })
    }
}

fn digest_of(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn manifest_for(bytes: &[u8]) -> ConnectorManifest {
    let yaml = MANIFEST_TEMPLATE.replace("DIGEST", &digest_of(bytes));
    ConnectorManifest::from_yaml(&yaml).expect("test manifest")
}

fn pinned_policy(digest: &str) -> HostPolicy {
    let mut policy = HostPolicy::default();
    policy.trusted_digests.insert(digest.to_owned());
    policy
}

fn request(operation: &str) -> InvokeRequest {
    let parameters = serde_json::json!({"q": "hello"});
    InvokeRequest {
        operation: operation.into(),
        resource: "res://demo".into(),
        audience: "aud://demo".into(),
        parameters_digest: opensesame_param_digest(&parameters),
        parameters,
        authorized_operation: operation.into(),
        invoke_level: Some(1),
        connection_ref: "conn://demo".into(),
    }
}

fn load_echo(limits: GuestLimits) -> WasmConnector {
    let bytes = ECHO_WAT.as_bytes();
    let manifest = manifest_for(bytes);
    let policy = pinned_policy(&digest_of(bytes));
    WasmConnector::load(manifest, bytes, &policy, Arc::new(RecordingEgress), limits)
        .expect("echo component loads")
}

#[test]
fn loads_describes_and_invokes() {
    let connector = load_echo(GuestLimits::default());
    assert_eq!(connector.id(), "echo");
    assert_eq!(connector.described_info(), ("echo", "1.0.0"));
    assert_eq!(connector.component_digest(), digest_of(ECHO_WAT.as_bytes()));
    assert!(connector.operations().contains(&"echo.read"));

    let result = connector.invoke(&request("echo.read")).expect("invoke ok");
    assert!(result.ok);
    // Ok([]) from the guest: not JSON, so the summary reports size only.
    assert_eq!(result.safe_summary["bytes"], 0);
    assert!(result
        .external_request_digest
        .as_deref()
        .is_some_and(|d| d.starts_with("sha256:")));
}

#[test]
fn a_tampered_component_is_refused_by_digest() {
    let bytes = ECHO_WAT.as_bytes();
    let manifest = manifest_for(bytes);
    let policy = pinned_policy(&digest_of(bytes));
    let tampered = ECHO_WAT.replace("echo1.0.0", "evil1.0.0");
    let result = WasmConnector::load(
        manifest,
        tampered.as_bytes(),
        &policy,
        Arc::new(RecordingEgress),
        GuestLimits::default(),
    );
    assert!(matches!(result, Err(HostError::DigestMismatch)));
}

#[test]
fn an_unpinned_digest_is_refused_even_when_it_matches() {
    let bytes = ECHO_WAT.as_bytes();
    let manifest = manifest_for(bytes);
    // Digest matches the manifest but the operator pinned nothing.
    let policy = HostPolicy::default();
    let result = WasmConnector::load(
        manifest,
        bytes,
        &policy,
        Arc::new(RecordingEgress),
        GuestLimits::default(),
    );
    assert!(matches!(result, Err(HostError::UntrustedComponent)));
}

#[test]
fn imports_outside_the_connector_world_fail_closed() {
    let bytes = FOREIGN_IMPORT_WAT.as_bytes();
    let yaml = MANIFEST_TEMPLATE.replace("DIGEST", &digest_of(bytes));
    let manifest = ConnectorManifest::from_yaml(&yaml).expect("manifest");
    let policy = pinned_policy(&digest_of(bytes));
    let result = WasmConnector::load(
        manifest,
        bytes,
        &policy,
        Arc::new(RecordingEgress),
        GuestLimits::default(),
    );
    match result {
        Err(HostError::Connector(msg)) => {
            assert!(
                msg.contains("outside the connector world"),
                "unexpected refusal: {msg}"
            );
        }
        Err(other) => panic!("foreign import must fail closed with a typed refusal, got {other:?}"),
        Ok(_) => panic!("foreign import must fail closed, but the load succeeded"),
    }
}

#[test]
fn an_infinite_loop_burns_out_its_fuel() {
    let connector = load_echo(GuestLimits {
        fuel: 500_000,
        ..GuestLimits::default()
    });
    let err = connector.invoke(&request("spin")).expect_err("must trap");
    assert!(
        matches!(&err, HostError::Connector(m) if m.contains("fuel exhausted")),
        "{err:?}"
    );
}

#[test]
fn the_wall_clock_deadline_interrupts_a_spinning_guest() {
    let connector = load_echo(GuestLimits {
        fuel: u64::MAX,
        deadline: Duration::from_millis(150),
        ..GuestLimits::default()
    });
    let started = std::time::Instant::now();
    let err = connector.invoke(&request("spin")).expect_err("must trap");
    assert!(
        matches!(&err, HostError::Connector(m) if m.contains("deadline exceeded")),
        "{err:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "deadline must fire promptly"
    );
}

#[test]
fn dispatcher_checks_run_before_the_guest() {
    let connector = load_echo(GuestLimits::default());

    let mut mismatched = request("echo.read");
    mismatched.authorized_operation = "other.op".into();
    assert!(matches!(
        connector.invoke(&mismatched),
        Err(HostError::OperationMismatch)
    ));

    let mut bad_digest = request("echo.read");
    bad_digest.parameters_digest = "sha256:not-the-digest".into();
    assert!(matches!(
        connector.invoke(&bad_digest),
        Err(HostError::ParameterDigestMismatch)
    ));

    let mut materialize = request("echo.read");
    materialize.invoke_level = Some(3);
    assert!(matches!(
        connector.invoke(&materialize),
        Err(HostError::MaterializeDenied)
    ));

    let unknown = request("not.in.manifest");
    assert!(matches!(
        connector.invoke(&unknown),
        Err(HostError::OperationMismatch)
    ));
}
