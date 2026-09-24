#![no_main]

use libfuzzer_sys::fuzz_target;
use opensesame_fuzz::fuzz_attachment_chunk;
use opensesame_fuzz::types::AttachmentChunkInput;

fuzz_target!(|input: AttachmentChunkInput| {
    fuzz_attachment_chunk(input);
});
