use super::*;

#[test]
fn id_mismatch_restores_the_session() {
    let mut host = CliAppIntegrationHost::new();
    let opened = open(&mut host, 40);
    let (message, confirm) = prove(&opened);
    let mismatch = host.finish_root_enroll(
        RootEnrollRequest {
            session_id: "ab",
            client_message: &message,
            client_confirm: confirm.client_confirm(),
            root_spki_der: &opened.spki,
        },
        40,
    );
    assert!(matches!(mismatch, Err(RootEnrollError::UnknownSession)));
    let finished = finish_with(
        &mut host,
        &opened,
        &message,
        confirm.client_confirm(),
        &opened.spki,
        40,
    )
    .expect("restored");
    assert_eq!(finished.enrollment_epoch(), 1);
}

#[test]
fn expiry_burns_the_session() {
    let mut host = CliAppIntegrationHost::new();
    let opened = open(&mut host, 50);
    let (message, confirm) = prove(&opened);
    let expired = finish_with(
        &mut host,
        &opened,
        &message,
        confirm.client_confirm(),
        &opened.spki,
        50 + ROOT_ENROLL_TTL_SECS,
    );
    assert_eq!(expired.unwrap_err(), RootEnrollError::Expired);
    let replay = finish_with(
        &mut host,
        &opened,
        &message,
        confirm.client_confirm(),
        &opened.spki,
        50,
    );
    assert_eq!(replay.unwrap_err(), RootEnrollError::UnknownSession);
}

#[test]
fn a_new_begin_replaces_the_pending_session() {
    let mut host = CliAppIntegrationHost::new();
    let first = open(&mut host, 60);
    let (message, confirm) = prove(&first);
    let second = host.begin_root_enroll(60).expect("replace");
    assert_eq!(
        finish_with(
            &mut host,
            &first,
            &message,
            confirm.client_confirm(),
            &first.spki,
            60,
        )
        .unwrap_err(),
        RootEnrollError::UnknownSession
    );
    let spki = root_spki_der(&generate_root_signing_key());
    let client = RootEnrollClient::start(&second.enrollment_secret).expect("second");
    let proof = client
        .confirm(&second.daemon_message, &spki)
        .expect("confirm");
    let finished = host
        .finish_root_enroll(
            RootEnrollRequest {
                session_id: &second.session_id,
                client_message: client.message(),
                client_confirm: proof.client_confirm(),
                root_spki_der: &spki,
            },
            60,
        )
        .expect("replacement finishes");
    assert_eq!(finished.record.enrollment_epoch(), 1);
}

#[test]
fn epoch_exhaustion_does_not_burn_the_session() {
    let mut host = CliAppIntegrationHost::new();
    let opened = open(&mut host, 70);
    let (message, confirm) = prove(&opened);
    let fingerprint = fingerprint_of_spki(&opened.spki);
    host.pairings
        .mark_root_key_enrolled(RootTrustRecord::new(fingerprint.clone(), u64::MAX).expect("max"));
    let exhausted = finish_with(
        &mut host,
        &opened,
        &message,
        confirm.client_confirm(),
        &opened.spki,
        70,
    );
    assert_eq!(exhausted.unwrap_err(), RootEnrollError::EpochExhausted);
    host.pairings
        .mark_root_key_enrolled(RootTrustRecord::new(fingerprint, 4).expect("lower"));
    let finished = finish_with(
        &mut host,
        &opened,
        &message,
        confirm.client_confirm(),
        &opened.spki,
        70,
    )
    .expect("session survived");
    assert_eq!(finished.enrollment_epoch(), 5);
}

#[test]
fn damaged_message_is_refused() {
    let mut host = CliAppIntegrationHost::new();
    let opened = open(&mut host, 80);
    let (_, confirm) = prove(&opened);
    assert_eq!(
        finish_with(
            &mut host,
            &opened,
            &[0x04; 64],
            confirm.client_confirm(),
            &opened.spki,
            80,
        )
        .unwrap_err(),
        RootEnrollError::InvalidMessage
    );
    assert!(RootEnrollClient::start(&[0x11; 32])
        .expect("client")
        .confirm(&[0x02; 65], &opened.spki)
        .is_err());
}
