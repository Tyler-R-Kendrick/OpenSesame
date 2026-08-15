#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::CapabilityAlgebraInput;
use opensesame_fuzz::fuzz_capability_algebra;

fuzz_target!(|input: CapabilityAlgebraInput| {
    fuzz_capability_algebra(input);
});
