//! Exact original lease custody control branches; no protocol/guard or authority changes.
use super::{refused, wire, OriginalSession};
use std::io;
impl OriginalSession {
    pub(super) fn capture_credential(&mut self) -> io::Result<wire::Reply> {
        Ok({
            if self.lease.is_some()
                || self.credential.is_some()
                || self.body.is_some()
                || self.reader.is_some()
                || self.bootstrap.is_some()
            {
                return Err(refused());
            }
            self.credential = Some(self.state.credential_writer()?);
            wire::Reply::Ack
        })
    }
    pub(super) fn capture_body(&mut self, tomb: &str) -> io::Result<wire::Reply> {
        Ok({
            if self.body.is_some() || self.reader.is_some() || self.bootstrap.is_some() {
                return Err(refused());
            }
            let credential = self.credential.as_ref().ok_or_else(refused)?;
            self.body = Some(credential.capture_existing_writer(tomb)?);
            wire::Reply::Ack
        })
    }
    pub(super) fn close_credential(&mut self) -> io::Result<wire::Reply> {
        Ok({
            if self.body.is_some()
                || self.bootstrap.is_some()
                || self.inventory.is_some()
                || self.credential.take().is_none()
            {
                return Err(refused());
            }
            wire::Reply::Ack
        })
    }
    pub(super) fn validate_resources(&mut self) -> io::Result<wire::Reply> {
        Ok({
            if let Some(writer) = self.body.as_ref() {
                writer.validate()?;
            }
            if let Some(inventory) = self.inventory.as_ref() {
                inventory.validate()?;
            }
            if let Some(credential) = self.credential.as_ref() {
                credential.validate()?;
            } else {
                self.state.validate()?;
            }
            wire::Reply::Ack
        })
    }
}
