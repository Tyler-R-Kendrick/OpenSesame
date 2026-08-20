#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::fuzz_whois_response;

fuzz_target!(|data: &[u8]| {
    fuzz_whois_response(data);
});
