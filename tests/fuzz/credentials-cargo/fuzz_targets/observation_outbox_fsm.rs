#![no_main]
use libfuzzer_sys::fuzz_target;
use opensesame_credential_fuzz::credential_oracles::outbox_fsm;
fuzz_target!(|bytes: &[u8]| {
    outbox_fsm(bytes);
});
