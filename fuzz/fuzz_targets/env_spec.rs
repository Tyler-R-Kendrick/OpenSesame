#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::fuzz_env_spec;

fuzz_target!(|data: &[u8]| {
    fuzz_env_spec(data);
});
