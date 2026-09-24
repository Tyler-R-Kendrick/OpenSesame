#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::fuzz_broker_seal;

fuzz_target!(|data: &[u8]| {
    fuzz_broker_seal(data);
});
