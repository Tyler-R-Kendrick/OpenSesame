#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::fuzz_aauth_parse;

fuzz_target!(|data: &[u8]| {
    fuzz_aauth_parse(data);
});
