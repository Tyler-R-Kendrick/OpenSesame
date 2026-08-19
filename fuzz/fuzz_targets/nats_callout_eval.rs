#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::NatsCalloutEvalInput;
use opensesame_fuzz::fuzz_nats_callout_eval;

fuzz_target!(|input: NatsCalloutEvalInput| {
    fuzz_nats_callout_eval(input);
});
