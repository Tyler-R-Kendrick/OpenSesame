#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::fuzz_grant_serde;

fuzz_target!(|data: &[u8]| {
    fuzz_grant_serde(data);
});
