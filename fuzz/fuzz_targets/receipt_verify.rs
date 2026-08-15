#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::fuzz_receipt_verify;

fuzz_target!(|data: &[u8]| {
    fuzz_receipt_verify(data);
});
