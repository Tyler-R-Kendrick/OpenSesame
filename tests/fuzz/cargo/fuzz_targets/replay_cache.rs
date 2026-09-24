#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::ReplayCacheInput;
use opensesame_fuzz::fuzz_replay_cache;

fuzz_target!(|input: ReplayCacheInput| {
    fuzz_replay_cache(input);
});
