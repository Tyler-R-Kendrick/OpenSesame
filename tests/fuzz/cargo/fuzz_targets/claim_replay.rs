#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::ClaimReplayInput;
use opensesame_fuzz::fuzz_claim_replay;

fuzz_target!(|input: ClaimReplayInput| {
    fuzz_claim_replay(input);
});
