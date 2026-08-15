#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::UriNormalizeInput;
use opensesame_fuzz::fuzz_uri_normalize;

fuzz_target!(|input: UriNormalizeInput| {
    fuzz_uri_normalize(input);
});
