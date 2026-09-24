#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::fuzz_oidc_discovery;

fuzz_target!(|data: &[u8]| {
    fuzz_oidc_discovery(data);
});
