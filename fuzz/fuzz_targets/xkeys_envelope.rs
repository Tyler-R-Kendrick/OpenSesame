#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::FuzzStr;
use opensesame_task_bus::{open_event_data, seal_event_data, SealedEventData};

fuzz_target!(|input: (FuzzStr, FuzzStr)| {
    let fixed = [11u8; 32];
    let kp = opensesame_xkeys::XKeyPair::from_secret_bytes(fixed);
    let plain = input.0.0.as_bytes();
    if plain.is_empty() {
        return;
    }
    let Ok(sealed) = seal_event_data(plain, &kp.public_bytes()) else {
        return;
    };
    let Ok(opened) = open_event_data(&sealed, &fixed) else {
        return;
    };
    assert_eq!(opened, plain);

    // Tamper oracle
    if !input.1.0.is_empty() {
        let mut tampered = SealedEventData {
            sealed_b64: sealed.sealed_b64.clone(),
        };
        tampered.sealed_b64.push('X');
        assert!(open_event_data(&tampered, &fixed).is_err());
    }
});
