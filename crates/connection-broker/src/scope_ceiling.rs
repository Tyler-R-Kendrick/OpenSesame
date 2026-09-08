//! Shared integration scope-ceiling admission.
use crate::{BrokerError, Result};

pub(crate) fn require_scope_subset(requested: &[String], ceiling: &[String]) -> Result<()> {
    if let Some(scope) = requested.iter().find(|scope| !ceiling.contains(scope)) {
        return Err(BrokerError::Invalid(format!(
            "scope `{scope}` exceeds the integration scope ceiling"
        )));
    }
    Ok(())
}
