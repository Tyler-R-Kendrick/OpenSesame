//! Original encrypted projection transport only, never human/root admission.
use super::{refused, wire, OriginalSession};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::io;
fn decode(values: Vec<(String, String)>) -> io::Result<Vec<(String, Vec<u8>)>> {
    values
        .into_iter()
        .map(|(name, value)| Ok((name, STANDARD.decode(value).map_err(|_| refused())?)))
        .collect()
}
impl OriginalSession {
    pub(super) fn apply_projection(&self, operation: wire::Operation) -> io::Result<wire::Reply> {
        match operation {
            wire::Operation::ValidateState {} => {
                if let Some(credential) = self.credential.as_ref() {
                    credential.validate()?;
                } else {
                    self.state.validate()?;
                }
                Ok(wire::Reply::Ack)
            }
            wire::Operation::PublishHeader { expected, next } => {
                self.writer()?.publish_authentication_header(
                    &STANDARD.decode(expected).map_err(|_| refused())?,
                    &STANDARD.decode(next).map_err(|_| refused())?,
                )?;
                Ok(wire::Reply::Ack)
            }
            wire::Operation::PublishProjection { expected, writes } => {
                self.writer()?
                    .publish_authentication_projection(&decode(expected)?, &decode(writes)?)?;
                Ok(wire::Reply::Ack)
            }
            wire::Operation::StateIdentity {} => Ok(wire::Reply::Identity {
                value: self.state.original_state_identity()?,
            }),
            wire::Operation::ReadProjection {} if self.bootstrap.is_some() => {
                self.bootstrap
                    .as_ref()
                    .ok_or_else(refused)?
                    .require_destination_absent()?;
                Ok(wire::Reply::Absent)
            }
            wire::Operation::ReadProjection {} => Ok(wire::Reply::Projection {
                records: self
                    .read_scope()?
                    .projection()?
                    .into_iter()
                    .map(|(path, bytes)| (path, STANDARD.encode(bytes)))
                    .collect(),
            }),
            _ => Err(refused()),
        }
    }
}
