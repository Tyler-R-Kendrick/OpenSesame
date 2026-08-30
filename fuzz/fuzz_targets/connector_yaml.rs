#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::fuzz_connector_yaml;

fuzz_target!(|data: &[u8]| {
    fuzz_connector_yaml(data);
});
