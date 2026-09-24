#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::fuzz_bitwarden_encstring;

fuzz_target!(|data: &[u8]| {
    fuzz_bitwarden_encstring(data);
});
