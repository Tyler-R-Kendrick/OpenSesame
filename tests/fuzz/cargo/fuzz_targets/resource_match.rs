#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::ResourceMatchInput;
use opensesame_fuzz::fuzz_resource_match;

fuzz_target!(|input: ResourceMatchInput| {
    fuzz_resource_match(input);
});
