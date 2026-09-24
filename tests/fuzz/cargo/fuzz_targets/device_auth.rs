#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::DeviceAuthInput;
use opensesame_fuzz::fuzz_device_auth;

fuzz_target!(|input: DeviceAuthInput| {
    fuzz_device_auth(input);
});
