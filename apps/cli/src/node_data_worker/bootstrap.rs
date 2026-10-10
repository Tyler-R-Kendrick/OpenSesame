//! Fixed actual-presence selector; lease-only bootstrap never becomes a DATA writer.
use super::{io, refused, wire, OriginalSession};
use opensesame_human_vault::root_protection::node_data_state::NativeNodeBodyCustody;
impl OriginalSession {
    pub(super) fn try_body_or_bootstrap(&mut self, tomb: &str) -> io::Result<wire::Reply> {
        if self.body.is_some() || self.reader.is_some() || self.bootstrap.is_some() {
            return Err(refused());
        }
        let credential = self.credential.as_ref().ok_or_else(refused)?;
        let selected = credential.try_capture_body_or_bootstrap(tomb)?;
        let acquired = selected.is_some();
        match selected {
            Some(NativeNodeBodyCustody::Writer(held)) => self.body = Some(held),
            Some(NativeNodeBodyCustody::Bootstrap(held)) => self.bootstrap = Some(held),
            None => (),
        }
        // This availability ACK cannot be used as owner authorization or a constructor input.
        Ok(wire::Reply::Available { acquired })
    }
    pub(super) fn bootstrap_absent(&self) -> io::Result<wire::Reply> {
        self.bootstrap
            .as_ref()
            .ok_or_else(refused)?
            .require_destination_absent()?;
        Ok(wire::Reply::Ack)
    }
    pub(super) fn close_body_custody(&mut self) -> io::Result<wire::Reply> {
        match (self.body.is_some(), self.bootstrap.is_some()) {
            (true, false) => {
                self.body.take();
            }
            (false, true) => self.bootstrap.take().ok_or_else(refused)?.close()?,
            _ => return Err(refused()),
        }
        Ok(wire::Reply::Ack)
    }
}
