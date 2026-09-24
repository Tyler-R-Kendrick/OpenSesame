#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::fuzz_openbao_response;

fuzz_target!(|data: &[u8]| {
    fuzz_openbao_response(data);
});
