#![no_main]
use libfuzzer_sys::fuzz_target;
use opensesame_credential_fuzz::credential_oracles::retired_records;
fuzz_target!(|bytes: &[u8]| {
    retired_records(bytes);
});
