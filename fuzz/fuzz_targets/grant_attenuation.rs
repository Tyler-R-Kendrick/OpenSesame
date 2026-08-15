#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::GrantPairInput;
use opensesame_fuzz::fuzz_grant_attenuation;

fuzz_target!(|input: GrantPairInput| {
    fuzz_grant_attenuation(input);
});
