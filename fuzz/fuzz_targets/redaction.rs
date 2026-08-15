#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::RedactionInput;
use opensesame_fuzz::fuzz_redaction;

fuzz_target!(|input: RedactionInput| {
    fuzz_redaction(input);
});
