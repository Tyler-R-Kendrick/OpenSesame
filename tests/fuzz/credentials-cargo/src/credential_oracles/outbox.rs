use super::fixture::{hostile_text, observation, IDENTITY, TOMB};
use chrono::{Duration, SecondsFormat};
use opensesame_human_vault::credential_canaries::{
    receiver::{acknowledge, ClosedEvent, Reservation, MAX_ATTEMPTS, MAX_ENTRIES},
    DeviceState,
};

pub fn outbox_fsm(bytes: &[u8]) {
    let raw = hostile_text(bytes, 131073);
    if let Ok(parsed) = DeviceState::parse(&raw, TOMB, IDENTITY) {
        let encoded = parsed.encode().unwrap();
        assert_eq!(
            DeviceState::parse(&encoded, TOMB, IDENTITY)
                .unwrap()
                .encode()
                .unwrap(),
            encoded
        );
        assert!(DeviceState::parse(&encoded, TOMB, "foreign-vault").is_err());
    }
    let (provision, mut metadata, _, _, mut now) = observation();
    let mut state = DeviceState::new(TOMB, IDENTITY);
    state.configure_receiver(provision.clone(), now).unwrap();
    let mut reservations: Vec<Reservation> = Vec::new();
    for (index, byte) in bytes.iter().take(64).enumerate() {
        match byte % 13 {
            0 => {
                let _ = state.test_receiver(now);
            }
            1 => reserve(&mut state, &mut reservations, now),
            2 | 3 => finish(&mut state, reservations.last(), *byte % 13 == 2, now),
            4 => {
                let _ = state.enable_receiver(false, now);
            }
            5 => {
                let before = state.outbox.history.len();
                if state.configure_receiver(provision.clone(), now).is_ok() {
                    assert_eq!(state.outbox.history.len(), before);
                    assert!(!state.receiver.as_ref().unwrap().verified);
                }
            }
            6 => {
                now += Duration::seconds([1, 5, 60, 3600, 86400][usize::from(*byte) % 5]);
            }
            7 => {
                let _ = state.enable_receiver(true, now);
            }
            9 => pin_owner(&mut state),
            10 => {
                let id = reservations
                    .last()
                    .map(|r| r.packet.package_id.as_str())
                    .unwrap_or("unknown");
                assert!(!state.owner_test_current(id, b"public-owner-policy-v2"));
            }
            11 => {
                if let Some(reservation) = reservations.last() {
                    state.remove_owner_test(&reservation.packet.package_id);
                    assert!(!state.owner_test_current(
                        &reservation.packet.package_id,
                        b"public-owner-policy-v1"
                    ));
                }
            }
            _ => {
                metadata.event = ClosedEvent::RetiredCredentialObserved {
                    trap_id: format!("subject-{index}"),
                    response: opensesame_human_vault::retired_credentials::Response::Reject,
                };
                metadata.at = now.to_rfc3339_opts(SecondsFormat::Millis, true);
                let _ = state.queue(&metadata, now);
            }
        }
        assert!(state.outbox.entries.len() <= MAX_ENTRIES);
        assert!(state.outbox.history.len() <= 8);
        assert!(state
            .outbox
            .entries
            .iter()
            .all(|entry| entry.attempts <= MAX_ATTEMPTS));
        let encoded = state.encode().unwrap();
        assert_eq!(
            DeviceState::parse(&encoded, TOMB, IDENTITY)
                .unwrap()
                .encode()
                .unwrap(),
            encoded
        );
        assert!(DeviceState::parse(&encoded, TOMB, "foreign-vault").is_err());
    }
}

// Independent public-state model: no production is_current/finish verdict is reused.
fn model_current(
    outbox: &opensesame_human_vault::credential_canaries::receiver::Outbox,
    config: &opensesame_human_vault::credential_canaries::receiver::Config,
    reservation: &Reservation,
    now: chrono::DateTime<chrono::Utc>,
) -> bool {
    let expiry: chrono::DateTime<chrono::Utc> = config.provision.expires_at.parse().unwrap();
    if expiry <= now
        || (!reservation.testing && !(config.enabled && config.verified))
        || serde_json::to_value(config).unwrap()
            != serde_json::to_value(&reservation.config).unwrap()
    {
        return false;
    }
    outbox.entries.iter().any(|entry| {
        entry.revision == config.revision
            && entry.attempts == reservation.attempt
            && entry.testing == reservation.testing
            && serde_json::to_value(&entry.package).unwrap()
                == serde_json::to_value(&reservation.packet).unwrap()
    })
}

fn reserve(
    state: &mut DeviceState,
    reservations: &mut Vec<Reservation>,
    now: chrono::DateTime<chrono::Utc>,
) {
    let Some(config) = state.receiver.as_ref() else {
        return;
    };
    let reserved = state.outbox.reserve(config, None, true, now).unwrap();
    if let Some(reservation) = reserved.filter(|_| reservations.len() < 16) {
        reservations.push(reservation);
    }
}

fn finish(
    state: &mut DeviceState,
    reservation: Option<&Reservation>,
    genuine: bool,
    now: chrono::DateTime<chrono::Utc>,
) {
    let (Some(reservation), Some(config)) = (reservation, state.receiver.as_mut()) else {
        return;
    };
    let ack = acknowledge(&reservation.packet, &reservation.config.provision, now)
        .ok()
        .map(|ack| serde_json::to_string(&ack).unwrap());
    let supplied = if genuine { ack.as_deref() } else { Some("{}") };
    let expected =
        genuine && ack.is_some() && model_current(&state.outbox, config, reservation, now);
    assert_eq!(
        state.outbox.finish(config, reservation, supplied, now),
        expected
    );
    if expected {
        assert!(!state.outbox.finish(config, reservation, supplied, now));
    }
}

fn pin_owner(state: &mut DeviceState) {
    let id = state
        .outbox
        .entries
        .iter()
        .find(|entry| entry.testing)
        .map(|entry| entry.package.package_id.clone());
    if let Some(id) = id {
        state
            .pin_owner_test(&id, b"public-owner-policy-v1")
            .unwrap();
        assert!(state.owner_test_current(&id, b"public-owner-policy-v1"));
        assert!(!state.owner_test_current(&id, b"public-owner-policy-v2"));
    }
}
