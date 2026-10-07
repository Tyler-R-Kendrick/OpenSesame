#![no_main]
use libfuzzer_sys::fuzz_target;
use opensesame_credential_fuzz::credential_oracles::observation_wire;
fuzz_target!(|bytes: &[u8]| {
    observation_wire(bytes);
});
