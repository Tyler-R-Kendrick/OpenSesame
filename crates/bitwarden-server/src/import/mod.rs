//! Moving people onto the Bitwarden-compatible server (ADR 0148).
//!
//! Two sources feed one writer:
//!
//! * [`vaultwarden`] reads a vaultwarden server's `SQLite` file: every
//!   registered account, with its server hash converted so the same master
//!   password signs in.
//! * [`account`] signs in to a live Bitwarden server as one person and reads
//!   their encrypted vault.
//!
//! Neither decrypts anything. A cipher arrives as the ciphertext its owner's
//! client wrote, is checked by the same parser that checks a client's own
//! writes, and is stored unchanged. What the server does not serve yet is
//! counted, never dropped silently.

pub mod account;
mod account_files;
pub mod vaultwarden;

mod files;
mod shared;

use std::collections::BTreeMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use opensesame_storage::bitwarden::{
    ArrivalOutcome, BitwardenArrival, BitwardenCipher, BitwardenFolder,
};

pub use files::{ArrivingAttachment, ArrivingSend, FileSource};
use opensesame_storage::Db;
use serde_json::{Map, Value};
pub use shared::{write_shared, ArrivingOrganization, OrgReport, SharedReport};

use crate::wire::cipher::parse_cipher;

/// Things an account holds that did not come with it, by kind, with counts.
pub type LeftBehind = BTreeMap<&'static str, usize>;

/// One account read from a source, ready to be written.
#[derive(Clone, Debug)]
pub struct Arrival {
    pub account: BitwardenArrival,
    pub left_behind: LeftBehind,
    /// Files on its ciphers, written after the account itself.
    pub attachments: Vec<ArrivingAttachment>,
    pub sends: Vec<ArrivingSend>,
}

/// An account a source holds but cannot move, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skipped {
    pub email: String,
    pub reason: String,
}

/// Everything read from one source.
#[derive(Clone, Debug, Default)]
pub struct Source {
    pub arrivals: Vec<Arrival>,
    pub skipped: Vec<Skipped>,
    /// Organizations, written after every account (see [`write_shared`]).
    pub organizations: Vec<ArrivingOrganization>,
    /// Emergency contacts between accounts, likewise.
    pub emergency: Vec<opensesame_storage::bitwarden::BitwardenEmergencyAccess>,
    /// Server-wide things that stay behind (groups and policies, for two).
    pub left_behind: LeftBehind,
    /// Where downloaded files wait to be written; gone with the source.
    pub scratch: Option<Arc<tempfile::TempDir>>,
}

/// How an account was written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Written {
    Created,
    Replaced,
    /// The email already has an account here; nothing was written.
    EmailTaken,
    /// An id the account carries belongs to another account here.
    IdTaken,
    /// `--dry-run`: read and checked, not written.
    DryRun,
}

/// What became of one account.
#[derive(Clone, Debug)]
pub struct AccountReport {
    pub email: String,
    pub written: Written,
    pub folders: usize,
    pub ciphers: usize,
    pub attachments: usize,
    pub sends: usize,
    pub left_behind: LeftBehind,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct WriteOptions {
    /// Replace an account already at the same email, with all it holds.
    pub replace: bool,
    /// Read and check everything; write nothing.
    pub dry_run: bool,
}

/// Write every arrival, each in its own transaction.
///
/// # Errors
///
/// Returns an error when the database fails; accounts written before it stay
/// written, and the one being written is rolled back whole.
pub async fn write(
    db: &Db,
    source: &Source,
    options: WriteOptions,
) -> anyhow::Result<Vec<AccountReport>> {
    let mut reports = Vec::with_capacity(source.arrivals.len());
    for arrival in &source.arrivals {
        let written = if options.dry_run {
            Written::DryRun
        } else {
            match db
                .bitwarden_arrive(&arrival.account, options.replace)
                .await?
            {
                ArrivalOutcome::Created => Written::Created,
                ArrivalOutcome::Replaced => Written::Replaced,
                ArrivalOutcome::EmailTaken => Written::EmailTaken,
                ArrivalOutcome::IdTaken => Written::IdTaken,
            }
        };
        let mut left_behind = arrival.left_behind.clone();
        let moved = if matches!(written, Written::Created | Written::Replaced) {
            files::write(db, arrival, &mut left_behind).await?
        } else {
            (arrival.attachments.len(), arrival.sends.len())
        };
        reports.push(AccountReport {
            email: arrival.account.user.email.clone(),
            written,
            folders: arrival.account.folders.len(),
            ciphers: arrival.account.ciphers.len(),
            attachments: moved.0,
            sends: moved.1,
            left_behind,
        });
    }
    Ok(reports)
}

/// Count one more of `kind` left behind.
pub(crate) fn leave(left: &mut LeftBehind, kind: &'static str, count: usize) {
    if count > 0 {
        *left.entry(kind).or_default() += count;
    }
}

/// Member names in lower camel case, all the way down. Older servers wrote
/// `PascalCase`; clients read either, and a single spelling keeps the stored
/// payload what a client writes today.
pub(crate) fn camel_deep(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let mut chars = key.chars();
                    let camel = chars
                        .next()
                        .map(|c| c.to_ascii_lowercase().to_string() + chars.as_str())
                        .unwrap_or_default();
                    (camel, camel_deep(value))
                })
                .collect::<Map<_, _>>(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(camel_deep).collect()),
        other => other,
    }
}

/// When a cipher was made, last changed, trashed and archived.
#[derive(Clone, Copy, Debug)]
pub(crate) struct CipherDates {
    pub created: DateTime<Utc>,
    pub revised: DateTime<Utc>,
    pub deleted: Option<DateTime<Utc>>,
    pub archived: Option<DateTime<Utc>>,
}

/// A cipher from its request-shaped JSON, checked as a client's own write is.
/// `None` when the parser refuses it; the caller counts it left behind.
pub(crate) fn cipher(
    user_id: &str,
    id: &str,
    request: Value,
    dates: CipherDates,
) -> Option<BitwardenCipher> {
    let input = parse_cipher(request, user_id).ok()?;
    Some(BitwardenCipher {
        id: id.to_owned(),
        user_id: Some(user_id.to_owned()),
        organization_id: None,
        folder_id: input.folder_id,
        cipher_type: input.cipher_type,
        favorite: input.favorite,
        data: input.data.to_string(),
        created_at: dates.created,
        revision_at: dates.revised,
        deleted_at: dates.deleted,
        archived_at: dates.archived,
    })
}

/// A folder whose name is ciphertext; anything else stays behind.
pub(crate) fn folder(
    user_id: &str,
    id: &str,
    name: &str,
    created: DateTime<Utc>,
    revised: DateTime<Utc>,
) -> Option<BitwardenFolder> {
    crate::wire::cipher::is_enc_string(name).then(|| BitwardenFolder {
        id: id.to_owned(),
        user_id: user_id.to_owned(),
        name: name.to_owned(),
        created_at: created,
        revision_at: revised,
    })
}

/// Drop folder references to folders that did not arrive, so a cipher never
/// points at a folder its owner does not have.
pub(crate) fn keep_known_folders(account: &mut BitwardenArrival) {
    let known: std::collections::HashSet<&str> =
        account.folders.iter().map(|f| f.id.as_str()).collect();
    let unknown: Vec<usize> = account
        .ciphers
        .iter()
        .enumerate()
        .filter(|(_, c)| c.folder_id.as_deref().is_some_and(|f| !known.contains(f)))
        .map(|(i, _)| i)
        .collect();
    for i in unknown {
        account.ciphers[i].folder_id = None;
    }
}

#[cfg(test)]
mod tests;
