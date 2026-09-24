#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::VaultMutateInput;
use opensesame_fuzz::fuzz_vault_envelope;

fuzz_target!(|input: VaultMutateInput| {
    fuzz_vault_envelope(input);
});
