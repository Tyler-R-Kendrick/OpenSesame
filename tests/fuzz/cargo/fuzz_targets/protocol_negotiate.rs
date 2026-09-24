#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::fuzz_protocol_negotiate;

fuzz_target!(|data: &[u8]| {
    fuzz_protocol_negotiate(data);
});
