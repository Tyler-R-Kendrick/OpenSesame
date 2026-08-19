#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::types::GithubWebhookHmacInput;
use opensesame_fuzz::fuzz_github_webhook_hmac;

fuzz_target!(|input: GithubWebhookHmacInput| {
    fuzz_github_webhook_hmac(input);
});
