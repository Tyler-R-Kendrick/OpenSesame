//! Enrollment session behavior and the frozen enrollment transcript.

use p256::ecdsa::SigningKey;
use serde::Deserialize;

use super::super::spake2::{evaluate, scalar_from_bytes};
use super::{
    enroll_aad, generate_root_signing_key, password_scalar, root_spki_der, EnrollmentConfirm,
    RootEnrollClient, RootEnrollRequest, CLIENT_ID, DAEMON_ID, ROOT_ENROLL_BEGIN_PATH,
    ROOT_ENROLL_FINISH_PATH, ROOT_ENROLL_TTL_SECS,
};
use crate::root_enroll::RootEnrollError;
use crate::root_trust::{fingerprint_of_spki, RootTrustRecord};
use crate::CliAppIntegrationHost;

const PAKE: &str = include_str!("../../../../spec/conformance/cli-root-enroll-pake.json");
const POLICY: &str = include_str!("../../../../spec/conformance/cli-app-integration.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorFile {
    protocol: ProtocolDoc,
    enrollment: EnrollmentCase,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProtocolDoc {
    client_identity: String,
    daemon_identity: String,
    aad_prefix: String,
    password_label: String,
    ttl_seconds: u64,
    begin_path: String,
    finish_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentCase {
    secret: String,
    x: String,
    y: String,
    root_scalar: String,
    p_a: String,
    p_b: String,
    c_a: String,
    c_b: String,
    root_spki: String,
    spki_fingerprint: String,
    enrollment_epoch: u64,
}

fn unhex<const N: usize>(value: &str) -> [u8; N] {
    let bytes = hex::decode(value).expect("hex");
    let len = bytes.len();
    bytes
        .try_into()
        .unwrap_or_else(|_| panic!("expected {N} bytes, got {len}"))
}

fn vectors() -> VectorFile {
    serde_json::from_str(PAKE).expect("pake vectors")
}

struct Opened {
    session_id: String,
    daemon_message: Vec<u8>,
    secret: Vec<u8>,
    spki: Vec<u8>,
    expires_at: u64,
}

fn open(host: &mut CliAppIntegrationHost, now: u64) -> Opened {
    let begun = host.begin_root_enroll(now).expect("begin");
    let spki = root_spki_der(&generate_root_signing_key());
    Opened {
        session_id: begun.session_id,
        daemon_message: begun.daemon_message,
        secret: begun.enrollment_secret.to_vec(),
        expires_at: begun.expires_at,
        spki,
    }
}

fn prove(opened: &Opened) -> (Vec<u8>, EnrollmentConfirm) {
    let client = RootEnrollClient::start(&opened.secret).expect("client");
    let confirm = client
        .confirm(&opened.daemon_message, &opened.spki)
        .expect("confirm");
    (client.message().to_vec(), confirm)
}

fn finish_with<'a>(
    host: &mut CliAppIntegrationHost,
    opened: &'a Opened,
    message: &'a [u8],
    confirm: &'a [u8],
    spki: &'a [u8],
    now: u64,
) -> Result<RootTrustRecord, RootEnrollError> {
    host.finish_root_enroll(
        RootEnrollRequest {
            session_id: &opened.session_id,
            client_message: message,
            client_confirm: confirm,
            root_spki_der: spki,
        },
        now,
    )
    .map(|finished| finished.record)
}

#[test]
fn published_protocol_matches_conformance() {
    let file = vectors();
    let policy: serde_json::Value = serde_json::from_str(POLICY).expect("policy");
    assert_eq!(file.protocol.client_identity.as_bytes(), CLIENT_ID);
    assert_eq!(file.protocol.daemon_identity.as_bytes(), DAEMON_ID);
    assert_eq!(file.protocol.aad_prefix.as_bytes(), super::AAD_PREFIX);
    assert_eq!(
        file.protocol.password_label.as_bytes(),
        super::PASSWORD_LABEL
    );
    assert_eq!(file.protocol.ttl_seconds, ROOT_ENROLL_TTL_SECS);
    assert_eq!(file.protocol.begin_path, ROOT_ENROLL_BEGIN_PATH);
    assert_eq!(file.protocol.finish_path, ROOT_ENROLL_FINISH_PATH);
    assert_eq!(
        policy["daemonPaths"]["rootEnrollBegin"],
        ROOT_ENROLL_BEGIN_PATH
    );
    assert_eq!(
        policy["daemonPaths"]["rootEnrollFinish"],
        ROOT_ENROLL_FINISH_PATH
    );
}

#[test]
fn enrollment_vector_matches_conformance() {
    let case = vectors().enrollment;
    assert_eq!(case.enrollment_epoch, 1);
    let secret = hex::decode(&case.secret).expect("secret");
    let key = SigningKey::from_slice(&unhex::<32>(&case.root_scalar)).expect("root key");
    let spki = root_spki_der(&key);
    let w = password_scalar(&secret).expect("password scalar");
    let x = scalar_from_bytes(&unhex(&case.x)).expect("x");
    let y = scalar_from_bytes(&unhex(&case.y)).expect("y");
    let transcript = evaluate(CLIENT_ID, DAEMON_ID, &w, &x, &y, &enroll_aad(&spki)).expect("eval");
    assert_eq!(hex::encode(transcript.p_a), case.p_a);
    assert_eq!(hex::encode(transcript.p_b), case.p_b);
    assert_eq!(hex::encode(transcript.c_a), case.c_a);
    assert_eq!(hex::encode(transcript.c_b), case.c_b);
    assert_eq!(hex::encode(&spki), case.root_spki);
    assert_eq!(fingerprint_of_spki(&spki), case.spki_fingerprint);
}

#[test]
fn secret_length_bounds() {
    match RootEnrollClient::start(&[]) {
        Err(RootEnrollError::InvalidSecret) => {}
        Err(other) => panic!("unexpected {other}"),
        Ok(_) => panic!("empty secret was accepted"),
    }
    assert!(RootEnrollClient::start(&[0x11; 15]).is_err());
    assert!(RootEnrollClient::start(&[0x11; 16]).is_ok());
    assert!(RootEnrollClient::start(&[0x11; 128]).is_ok());
    assert!(RootEnrollClient::start(&[0x11; 129]).is_err());
}

#[test]
fn round_trip_does_not_mark_enrolled_until_the_caller_does() {
    let mut host = CliAppIntegrationHost::new();
    let opened = open(&mut host, 1_000);
    assert_eq!(opened.expires_at, 1_000 + ROOT_ENROLL_TTL_SECS);
    let (message, confirm) = prove(&opened);
    let finished = finish_with(
        &mut host,
        &opened,
        &message,
        confirm.client_confirm(),
        &opened.spki,
        1_000,
    )
    .expect("finish");
    assert_eq!(finished.enrollment_epoch(), 1);
    assert_eq!(
        finished.spki_fingerprint(),
        fingerprint_of_spki(&opened.spki)
    );
    assert!(!host.pairings.is_root_key_enrolled());
    assert!(host.pairings.root_trust().is_none());
    let replay = finish_with(
        &mut host,
        &opened,
        &message,
        confirm.client_confirm(),
        &opened.spki,
        1_000,
    );
    assert_eq!(replay.unwrap_err(), RootEnrollError::UnknownSession);
    host.pairings.mark_root_key_enrolled(finished);
    assert!(host.pairings.is_root_key_enrolled());
    assert_eq!(enroll_again(&mut host, 2_000).enrollment_epoch(), 2);
}

#[test]
fn test_seam_enrollment_still_uses_epoch_one() {
    let mut host = CliAppIntegrationHost::new();
    host.pairings.enroll_root_key_for_tests();
    let opened = open(&mut host, 10);
    let (message, confirm) = prove(&opened);
    let finished = finish_with(
        &mut host,
        &opened,
        &message,
        confirm.client_confirm(),
        &opened.spki,
        10,
    )
    .expect("finish");
    assert_eq!(finished.enrollment_epoch(), 1);
}

#[test]
fn wrong_secret_is_refused_and_burns_the_session() {
    let mut host = CliAppIntegrationHost::new();
    let opened = open(&mut host, 20);
    let other = RootEnrollClient::start(&[0x22; 32]).expect("other secret");
    let wrong = other
        .confirm(&opened.daemon_message, &opened.spki)
        .expect("wrong confirm");
    let refused = finish_with(
        &mut host,
        &opened,
        other.message(),
        wrong.client_confirm(),
        &opened.spki,
        20,
    );
    assert_eq!(refused.unwrap_err(), RootEnrollError::InvalidConfirm);
    let (message, confirm) = prove(&opened);
    let replay = finish_with(
        &mut host,
        &opened,
        &message,
        confirm.client_confirm(),
        &opened.spki,
        20,
    );
    assert_eq!(replay.unwrap_err(), RootEnrollError::UnknownSession);
}

#[test]
fn bad_confirm_and_swapped_spki_are_refused() {
    let mut host = CliAppIntegrationHost::new();
    let opened = open(&mut host, 21);
    let (message, confirm) = prove(&opened);
    let mut bad = confirm.client_confirm().to_vec();
    bad[0] ^= 0xff;
    assert_eq!(
        finish_with(&mut host, &opened, &message, &bad, &opened.spki, 21).unwrap_err(),
        RootEnrollError::InvalidConfirm
    );

    let mut host = CliAppIntegrationHost::new();
    let opened = open(&mut host, 22);
    let (message, confirm) = prove(&opened);
    let other_spki = root_spki_der(&generate_root_signing_key());
    assert_eq!(
        finish_with(
            &mut host,
            &opened,
            &message,
            confirm.client_confirm(),
            &other_spki,
            22,
        )
        .unwrap_err(),
        RootEnrollError::InvalidConfirm
    );
}

#[test]
fn raw_sec1_is_not_a_root_spki() {
    let mut host = CliAppIntegrationHost::new();
    let opened = open(&mut host, 30);
    let key = generate_root_signing_key();
    let raw = key.verifying_key().to_sec1_point(false);
    let raw = raw.as_bytes().to_vec();
    let client = RootEnrollClient::start(&opened.secret).expect("client");
    let confirm = client
        .confirm(&opened.daemon_message, &raw)
        .expect("confirm");
    let message = client.message().to_vec();
    let err = finish_with(
        &mut host,
        &opened,
        &message,
        confirm.client_confirm(),
        &raw,
        30,
    );
    assert_eq!(err.unwrap_err(), RootEnrollError::InvalidSpki);
}

fn enroll_again(host: &mut CliAppIntegrationHost, now: u64) -> RootTrustRecord {
    let opened = open(host, now);
    let (message, confirm) = prove(&opened);
    let record = finish_with(
        host,
        &opened,
        &message,
        confirm.client_confirm(),
        &opened.spki,
        now,
    )
    .expect("finish");
    host.pairings.mark_root_key_enrolled(record.clone());
    record
}

mod lifecycle;
