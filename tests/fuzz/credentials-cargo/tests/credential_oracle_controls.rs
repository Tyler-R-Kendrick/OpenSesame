//! Deterministic controls for real public-API fuzz oracles; no network or auth mocks.
#[path = "../src/credential_oracles/fixture.rs"]
mod fixture;
use chrono::Duration;
use opensesame_credential_fuzz::credential_oracles::{
    canary_registry, observation_wire, outbox_fsm, retired_records,
};
use opensesame_human_vault::credential_canaries::{
    receiver::{acknowledge, verify_acknowledgement},
    DeviceState,
};

#[test]
fn credential_oracles_accept_structured_and_hostile_seed_inputs() {
    assert_eq!(fixture::hostile_text(b"bounded", 3), "bou");
    for input in [&[][..], &[0, 1], &[3, 1], &[4, 1], b"{\"v\":1}", &[255; 64]] {
        retired_records(input);
        canary_registry(input);
        observation_wire(input);
        outbox_fsm(input);
    }
}

#[test]
fn bounded_transition_seed_reaches_ack_disable_replace_expiry_and_owner_witness() {
    outbox_fsm(&[0, 1, 9, 2, 2, 4, 5, 0, 1, 3, 7, 12, 6, 1, 11]);
    let mut word = 0x1234_5678_u32;
    for _ in 0..16 {
        let input = std::array::from_fn::<u8, 64, _>(|_| {
            word ^= word << 13;
            word ^= word >> 17;
            word ^= word << 5;
            word.to_le_bytes()[0]
        });
        outbox_fsm(&input);
    }
}

#[test]
fn genuine_golden_ack_rejects_tampering_other_package_and_expiry() {
    let (provision, _, packet, vector, now) = fixture::observation();
    assert!(verify_acknowledgement(
        &vector["ack"].to_string(),
        &packet,
        &provision,
        now + Duration::seconds(1)
    )
    .is_ok());
    let mut tampered = vector["ack"].clone();
    tampered["keyEpoch"] = 8.into();
    assert!(verify_acknowledgement(&tampered.to_string(), &packet, &provision, now).is_err());
    assert!(verify_acknowledgement(
        &vector["ack"].to_string(),
        &packet,
        &provision,
        now + Duration::hours(24)
    )
    .is_err());
    observation_wire(b"closed-wire-control");
}

#[test]
fn genuine_queued_ack_cannot_revalidate_replaced_or_disabled_binding() {
    let (provision, _, _, _, now) = fixture::observation();
    let mut state = DeviceState::new(fixture::TOMB, fixture::IDENTITY);
    state.configure_receiver(provision.clone(), now).unwrap();
    let id = state.test_receiver(now).unwrap().unwrap();
    state
        .pin_owner_test(&id, b"public-owner-policy-v1")
        .unwrap();
    assert!(state.owner_test_current(&id, b"public-owner-policy-v1"));
    assert!(!state.owner_test_current(&id, b"public-owner-policy-v2"));
    let reservation = state
        .outbox
        .reserve(state.receiver.as_ref().unwrap(), Some(&id), true, now)
        .unwrap()
        .unwrap();
    let ack =
        serde_json::to_string(&acknowledge(&reservation.packet, &provision, now).unwrap()).unwrap();
    let count = state.outbox.history.len();
    state.enable_receiver(false, now).unwrap();
    assert!(!state.outbox.finish(
        state.receiver.as_mut().unwrap(),
        &reservation,
        Some(&ack),
        now
    ));
    assert!(!state.receiver.as_ref().unwrap().verified);
    assert_eq!(state.outbox.history.len(), count);
    state.configure_receiver(provision, now).unwrap();
    assert!(!state.outbox.finish(
        state.receiver.as_mut().unwrap(),
        &reservation,
        Some(&ack),
        now
    ));
    assert!(!state.owner_test_current(&id, b"public-owner-policy-v1"));
    assert!(state.enable_receiver(true, now).is_err());
}
