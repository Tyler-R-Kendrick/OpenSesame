//! Trust Ratchet task access engine for `OpenSesame`.

pub mod credential;
pub mod engine;
pub mod error;
pub mod postgres;
pub mod sqlite_store;

pub use credential::*;
pub use engine::*;
pub use error::*;
pub use postgres::*;
pub use sqlite_store::*;

pub(crate) fn db_i64(value: u64) -> Result<i64, TaskAccessError> {
    i64::try_from(value)
        .map_err(|_| TaskAccessError::Storage("task state version exceeds database range".into()))
}

pub(crate) fn db_u64(value: i64) -> Result<u64, TaskAccessError> {
    u64::try_from(value)
        .map_err(|_| TaskAccessError::Storage("negative task state version in database".into()))
}

#[cfg(test)]
mod tests;
