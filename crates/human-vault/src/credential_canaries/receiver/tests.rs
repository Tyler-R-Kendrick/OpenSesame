mod observation_vector {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../human-vault/tests/support/credential_observation_vector.rs"
    ));
}
use super::*;
use chrono::{Duration, Utc};
use serde_json::Value;

fn fixture() -> (Value, Provision, Metadata, chrono::DateTime<Utc>) {
    let value: Value = serde_json::from_str(include_str!(
        "../../../../../packages/app-core/src/lib/credential-observation/protocol-vectors.json"
    ))
    .unwrap();
    let provision = serde_json::from_value(observation_vector::provision_json(&value)).unwrap();
    let metadata = serde_json::from_value(value["metadata"].clone()).unwrap();
    let now = "2026-10-06T00:00:00.000Z".parse().unwrap();
    (value, provision, metadata, now)
}
#[test]
fn shared_aes_gcm_hmac_package_and_ack_vectors_match_exactly() {
    let (vector, provision, metadata, now) = fixture();
    let packet = seal::seal_with_randomness(
        &metadata,
        &provision,
        now,
        "22222222-2222-4222-8222-222222222222",
        std::array::from_fn(|i| 64 + u8::try_from(i).unwrap()),
        std::array::from_fn(|i| 80 + u8::try_from(i).unwrap()),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_string(&metadata).unwrap(),
        vector["plaintext"].as_str().unwrap()
    );
    assert_eq!(
        packet.body().unwrap(),
        vector["packageBody"].as_str().unwrap()
    );
    assert_eq!(serde_json::to_value(&packet).unwrap(), vector["packet"]);
    let ack = acknowledge(&packet, &provision, now + Duration::seconds(1)).unwrap();
    assert_eq!(ack.body().unwrap(), vector["ackBody"].as_str().unwrap());
    assert_eq!(serde_json::to_value(&ack).unwrap(), vector["ack"]);
    assert_eq!(
        serde_json::to_value(open(&packet.body_with_mac(), &provision, now).unwrap()).unwrap(),
        vector["metadata"]
    );
    verify_acknowledgement(
        &serde_json::to_string(&ack).unwrap(),
        &packet,
        &provision,
        now + Duration::seconds(1),
    )
    .unwrap();
}
#[test]
fn receiver_rejects_tampering_wrong_binding_expiry_and_unsealed_ack() {
    let (_, provision, metadata, now) = fixture();
    let packet = seal(&metadata, &provision, now).unwrap();
    assert!(verify_acknowledgement("{\"ok\":true}", &packet, &provision, now).is_err());
    let mut changed = packet.clone();
    changed.nonce_b64 = "AAAAAAAAAAAAAAAAAAAAAA==".into();
    assert!(open(&changed.body_with_mac(), &provision, now).is_err());
    changed = packet.clone();
    changed.binding_id = "other".into();
    assert!(authenticate(&changed, &provision, now).is_err());
    assert!(open(
        &packet.body_with_mac(),
        &provision,
        now + Duration::hours(24)
    )
    .is_err());
    let mut key_changed = provision.clone();
    key_changed.independent_key_material_b64 =
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [0u8; 64]);
    assert!(open(&packet.body_with_mac(), &key_changed, now).is_err());
    let mut clear = serde_json::to_value(&metadata).unwrap();
    clear["password"] = "must not cross this boundary".into();
    assert!(serde_json::from_value::<Metadata>(clear).is_err());
}
#[test]
fn receiver_destination_accepts_only_pinned_canonical_origins() {
    let (_, provision, _, _) = fixture();
    assert_eq!(
        provision.destination().unwrap(),
        "https://receiver.example/v1/credential-observations"
    );
    for origin in [
        "https://user:secret@receiver.example",
        "https://receiver.example/",
        "https://receiver.example:443",
        "https://receiver.example/path",
        "https://receiver.example?target=x",
        "http://receiver.example",
        "http://127.0.0.1:8181",
    ] {
        let mut changed = provision.clone();
        changed.origin = origin.into();
        assert!(changed.validate().is_err(), "{origin}");
    }
    let mut local = provision.clone();
    local.origin = "http://127.0.0.1:8181".into();
    local.allow_loopback = true;
    assert!(local.validate().is_ok());
    local.origin = "http://[::1]:8181".into();
    assert!(local.validate().is_ok());
}
#[test]
fn outbox_requires_ack_current_revision_and_bounded_retries() {
    let (_, provision, metadata, now) = fixture();
    let mut config = Config {
        v: 1,
        tomb: "fixture-tomb".into(),
        vault_identity: metadata.vault_identity.clone(),
        revision: uuid::Uuid::new_v4().to_string(),
        provision,
        enabled: false,
        verified: false,
    };
    let mut outbox = Outbox::new(&config.tomb, &config.vault_identity);
    assert!(outbox
        .append(&config, &metadata, false, now)
        .unwrap()
        .is_none());
    let id = outbox
        .append(&config, &metadata, true, now)
        .unwrap()
        .unwrap();
    assert!(outbox
        .append(&config, &metadata, true, now + Duration::seconds(1))
        .unwrap()
        .is_none());
    let reservation = outbox
        .reserve(&config, Some(&id), true, now)
        .unwrap()
        .unwrap();
    assert!(outbox
        .reserve(&config, Some(&id), true, now + Duration::seconds(1))
        .unwrap()
        .is_none());
    let ack = acknowledge(&reservation.packet, &config.provision, now).unwrap();
    let mut revoked = config.clone();
    revoked.revision = uuid::Uuid::new_v4().to_string();
    assert!(!outbox.finish(
        &mut revoked,
        &reservation,
        Some(&serde_json::to_string(&ack).unwrap()),
        now
    ));
    assert_eq!(outbox.entries.len(), 1);
    assert!(outbox.finish(
        &mut config,
        &reservation,
        Some(&serde_json::to_string(&ack).unwrap()),
        now
    ));
    assert!(config.verified);
    assert!(outbox.entries.is_empty());
    config.enabled = true;
    let id = outbox
        .append(&config, &metadata, false, now + Duration::seconds(61))
        .unwrap()
        .unwrap();
    for attempt in 1..=MAX_ATTEMPTS {
        let at = now + Duration::seconds(61 + i64::from(attempt) * 5);
        let current = outbox
            .reserve(&config, Some(&id), false, at)
            .unwrap()
            .unwrap();
        assert_eq!(current.attempt, attempt);
        assert!(!outbox.finish(&mut config, &current, None, at));
    }
    assert!(outbox
        .reserve(&config, Some(&id), false, now + Duration::seconds(100))
        .unwrap()
        .is_none());
    assert_eq!(outbox.failed, MAX_ATTEMPTS);
    let loaded = Outbox::parse(
        &outbox.encode().unwrap(),
        &config.tomb,
        &config.vault_identity,
    )
    .unwrap();
    assert_eq!(loaded.entries.len(), 1);
    assert!(Outbox::parse(&outbox.encode().unwrap(), "foreign", &config.vault_identity).is_err());
    outbox.discard_expired(&revoked, now);
    assert!(outbox.entries.is_empty());
}
impl Package {
    fn body_with_mac(&self) -> String {
        serde_json::to_string(self).unwrap()
    }
}

#[test]
fn password_budget_survives_owner_reconfiguration_and_response_changes() {
    let (_, provision, mut metadata, now) = fixture();
    let mut state = super::super::DeviceState::new("fixture-tomb", &metadata.vault_identity);
    state.configure_receiver(provision.clone(), now).unwrap();
    state.receiver.as_mut().unwrap().verified = true;
    state.enable_receiver(true, now).unwrap();
    metadata.event = ClosedEvent::RetiredCredentialObserved {
        trap_id: "selected-trap".into(),
        response: crate::retired_credentials::Response::Reject,
    };
    assert!(state.queue(&metadata, now).unwrap().is_some());
    state.outbox.failed = 7;
    state.enable_receiver(false, now).unwrap();
    state.enable_receiver(true, now).unwrap();
    metadata.event = ClosedEvent::RetiredCredentialObserved {
        trap_id: "selected-trap".into(),
        response: crate::retired_credentials::Response::SyntheticDecoy,
    };
    assert!(state
        .queue(&metadata, now + Duration::seconds(1))
        .unwrap()
        .is_none());
    assert_eq!(state.outbox.history.len(), 1);
    state.remove_receiver();
    state.configure_receiver(provision, now).unwrap();
    assert_eq!(state.outbox.failed, 7);
    assert_eq!(state.outbox.history.len(), 1);
    state.receiver.as_mut().unwrap().verified = true;
    state.enable_receiver(true, now).unwrap();
    for i in 1..8 {
        metadata.event = ClosedEvent::RetiredCredentialObserved {
            trap_id: format!("selected-trap-{i}"),
            response: crate::retired_credentials::Response::Reject,
        };
        assert!(state.queue(&metadata, now).unwrap().is_some());
    }
    state
        .configure_receiver(state.receiver.as_ref().unwrap().provision.clone(), now)
        .unwrap();
    state.receiver.as_mut().unwrap().verified = true;
    state.enable_receiver(true, now).unwrap();
    metadata.event = ClosedEvent::ReceiverTest;
    assert!(state.queue(&metadata, now).unwrap().is_none());
    assert_eq!(state.outbox.history.len(), 8);
}
#[test]
fn pending_ack_cannot_survive_disable_reenable_or_replaced_binding() {
    let (_, provision, metadata, now) = fixture();
    let mut state = super::super::DeviceState::new("fixture-tomb", &metadata.vault_identity);
    state.configure_receiver(provision.clone(), now).unwrap();
    state.receiver.as_mut().unwrap().verified = true;
    state.enable_receiver(true, now).unwrap();
    let id = state.queue(&metadata, now).unwrap().unwrap();
    let reservation = state
        .outbox
        .reserve(state.receiver.as_ref().unwrap(), Some(&id), false, now)
        .unwrap()
        .unwrap();
    let ack =
        serde_json::to_string(&acknowledge(&reservation.packet, &provision, now).unwrap()).unwrap();
    let mut tampered = reservation.clone();
    tampered.packet.ciphertext_b64 = "invalid".into();
    assert!(!state
        .outbox
        .is_current(state.receiver.as_ref().unwrap(), &tampered, now));
    state.enable_receiver(false, now).unwrap();
    state.enable_receiver(true, now).unwrap();
    assert!(!state.outbox.finish(
        state.receiver.as_mut().unwrap(),
        &reservation,
        Some(&ack),
        now
    ));
    state.configure_receiver(provision, now).unwrap();
    assert!(!state.outbox.finish(
        state.receiver.as_mut().unwrap(),
        &reservation,
        Some(&ack),
        now
    ));
    assert!(!state.receiver.as_ref().unwrap().verified);
}
