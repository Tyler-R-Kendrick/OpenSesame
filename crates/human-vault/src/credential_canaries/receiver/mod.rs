//! Independent sealed metadata; no production credential or vault key is accepted here.
pub(super) mod protocol;
mod queue;
mod seal;

pub use protocol::{
    Acknowledgement, ClosedEvent, Metadata, Package, Provision, ReceiverError, ACK_PURPOSE,
    MAX_PACKAGE_BYTES, PURPOSE, ROUTE,
};
pub use queue::{
    Config, Entry, History, Outbox, Reservation, MAX_ATTEMPTS, MAX_ENTRIES, MAX_OUTBOX_BYTES,
};
#[cfg(test)]
mod tests;
pub use seal::{acknowledge, authenticate, open, seal, verify_acknowledgement};
