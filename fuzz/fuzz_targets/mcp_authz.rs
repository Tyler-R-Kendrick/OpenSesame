#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::fuzz_mcp_authz;

fuzz_target!(|data: &[u8]| {
    fuzz_mcp_authz(data);
});
