#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::fuzz_promote_request;

fuzz_target!(|data: &[u8]| {
    fuzz_promote_request(data);
});
