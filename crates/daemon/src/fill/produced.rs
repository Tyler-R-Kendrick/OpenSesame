//! A fill value, produced through the facade (ADR 0174).

use super::source::SourceError;
use opensesame_sealed_store::{produce_entry, Produced};
use zeroize::Zeroizing;

/// One field's value, and whether the person's own pepper must follow it.
pub(super) struct Filled {
    pub(super) value: Zeroizing<String>,
    pub(super) pepper: bool,
}

/// An entry's password through the one facade the app and the terminal use
/// (ADR 0174): a stored one as it is, one an algorithm computes from the
/// parameters in the entry, and one with a slot for a pepper only as far as the
/// slot. The pepper is never asked for or stored; what an older version sealed
/// under one is refused.
pub(super) fn password_of(entry: &opensesame_sealed_store::Entry) -> Result<Filled, SourceError> {
    match produce_entry(entry) {
        Produced::Ok(value) => Ok(Filled {
            value,
            pepper: false,
        }),
        Produced::Slotted { head, .. } => Ok(Filled {
            value: head,
            pepper: true,
        }),
        Produced::Absent => Err(SourceError::Missing),
        Produced::Legacy => Err(SourceError::Legacy),
    }
}
