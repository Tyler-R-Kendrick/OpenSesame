//! Quarantine helpers — record type lives in `ops` for store cohesion.

use crate::duress::ops::QuarantineRecord;

/// Accurate already-dispatched style reporting for peer quarantine acceptance.
#[must_use]
pub fn mark_quarantine_active(mut record: QuarantineRecord) -> QuarantineRecord {
    record.active = true;
    record
}

#[must_use]
pub fn mark_quarantine_inactive(mut record: QuarantineRecord) -> QuarantineRecord {
    record.active = false;
    record
}
