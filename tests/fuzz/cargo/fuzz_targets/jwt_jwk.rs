#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::JwtJwkInput;
use opensesame_fuzz::fuzz_jwt_jwk;

fuzz_target!(|input: JwtJwkInput| {
    fuzz_jwt_jwk(input);
});
