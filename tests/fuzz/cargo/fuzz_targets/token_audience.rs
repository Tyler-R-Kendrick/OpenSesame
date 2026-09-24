#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::TokenAudienceInput;
use opensesame_fuzz::fuzz_token_audience;

fuzz_target!(|input: TokenAudienceInput| {
    fuzz_token_audience(input);
});
