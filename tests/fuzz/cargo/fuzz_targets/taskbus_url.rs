#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::FuzzStr;
use opensesame_task_bus::validate_nats_url;

fuzz_target!(|url: FuzzStr| {
    let url = url.0;
    match validate_nats_url(&url) {
        Ok(()) => {
            let lower = url.to_ascii_lowercase();
            assert!(lower.starts_with("nats://") || lower.starts_with("tls://"));
            assert!(!lower.contains(' '));
        }
        Err(_) => {}
    }
});
