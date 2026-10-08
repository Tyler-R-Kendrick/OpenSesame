#![no_main]
use libfuzzer_sys::fuzz_target;
use opensesame_credential_fuzz::credential_oracles::canary_registry;
fuzz_target!(|bytes: &[u8]| {
    canary_registry(bytes);
});
