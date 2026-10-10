//! Fixed authenticated ciphertext publication; the original session owns custody.
use super::{ciphertext_input, io, refused, wire, OriginalSession};
impl OriginalSession {
    pub(super) fn publish_ciphertext(&self, operation: wire::Operation) -> io::Result<wire::Reply> {
        let reply = match operation {
            wire::Operation::PublishGeneration { expected, next } => {
                let expected = ciphertext_input(expected)?;
                let next = ciphertext_input(next)?;
                self.writer()?
                    .compare_publish_generation_ciphertext(expected.as_deref(), next.as_deref())?;
                wire::Reply::Ack
            }
            wire::Operation::PublishDevice {
                logical_key,
                expected,
                next,
            } => {
                let expected = ciphertext_input(expected)?;
                let next = ciphertext_input(next)?;
                self.writer()?.compare_publish_modern_device_ciphertext(
                    &logical_key,
                    expected.as_deref(),
                    next.as_deref(),
                )?;
                wire::Reply::Ack
            }
            _ => return Err(refused()),
        };
        Ok(reply)
    }
}
