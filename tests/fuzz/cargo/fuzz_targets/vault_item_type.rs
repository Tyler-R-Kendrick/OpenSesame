#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::fuzz_vault_item_type;

fuzz_target!(|data: &[u8]| {
    fuzz_vault_item_type(data);
});
