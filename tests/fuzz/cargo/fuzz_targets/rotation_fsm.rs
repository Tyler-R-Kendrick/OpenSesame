#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::RotationSeqInput;
use opensesame_fuzz::fuzz_rotation_fsm;

fuzz_target!(|input: RotationSeqInput| {
    fuzz_rotation_fsm(input);
});
