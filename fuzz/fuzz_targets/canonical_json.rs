#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::BoundedJson;
use opensesame_fuzz::fuzz_canonical_json;

fuzz_target!(|input: BoundedJson| {
    fuzz_canonical_json(input);
});
