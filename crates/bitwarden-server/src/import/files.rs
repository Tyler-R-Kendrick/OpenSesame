//! An account's files on the way in (ADR 0148): attachments and Sends, each
//! written in its own transaction once the account itself has landed, so one
//! unreadable file costs that file and nothing else.

use std::path::PathBuf;

use opensesame_storage::bitwarden::{BitwardenAttachment, BitwardenSend};
use opensesame_storage::Db;

use super::{leave, Arrival, LeftBehind};

/// Where a file's ciphertext is to be read from at write time.
#[derive(Clone, Debug)]
pub enum FileSource {
    /// A file on disk: vaultwarden's data folder, or a download waiting in
    /// the import's scratch folder.
    Disk(PathBuf),
}

impl FileSource {
    fn read(&self) -> Option<Vec<u8>> {
        match self {
            Self::Disk(path) => std::fs::read(path).ok(),
        }
    }
}

/// An attachment as it arrives, uploaded, with where its bytes are.
#[derive(Clone, Debug)]
pub struct ArrivingAttachment {
    pub attachment: BitwardenAttachment,
    pub source: FileSource,
}

/// A Send as it arrives, with its file's bytes if it is a file Send.
#[derive(Clone, Debug)]
pub struct ArrivingSend {
    pub send: BitwardenSend,
    pub file: Option<FileSource>,
}

/// Write arriving attachments, each on its own. Returns how many landed.
pub(super) async fn write_attachments(
    db: &Db,
    arriving: &[ArrivingAttachment],
    left_behind: &mut LeftBehind,
) -> anyhow::Result<usize> {
    let mut written = 0;
    for file in arriving {
        let Some(bytes) = file.source.read() else {
            leave(left_behind, "attachments whose file could not be read", 1);
            continue;
        };
        let mut attachment = file.attachment.clone();
        attachment.size = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
        if db.bitwarden_import_attachment(&attachment, &bytes).await? {
            written += 1;
        } else {
            leave(left_behind, "attachments whose id is taken here", 1);
        }
    }
    Ok(written)
}

/// Write an arrived account's files. Returns how many attachments and Sends
/// landed; the rest are counted in `left_behind` with the reason.
pub(super) async fn write(
    db: &Db,
    arrival: &Arrival,
    left_behind: &mut LeftBehind,
) -> anyhow::Result<(usize, usize)> {
    let attachments = write_attachments(db, &arrival.attachments, left_behind).await?;
    let mut sends = 0;
    for arriving in &arrival.sends {
        let bytes = if let Some(source) = &arriving.file {
            let Some(bytes) = source.read() else {
                leave(left_behind, "file Sends whose file could not be read", 1);
                continue;
            };
            Some(bytes)
        } else {
            None
        };
        if db
            .bitwarden_import_send(&arriving.send, bytes.as_deref())
            .await?
        {
            sends += 1;
        } else {
            leave(left_behind, "Sends whose id is taken here", 1);
        }
    }
    Ok((attachments, sends))
}
