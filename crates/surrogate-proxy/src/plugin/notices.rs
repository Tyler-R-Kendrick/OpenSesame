//! Where the plugin's tripwires go: every refusal, converted by
//! `opensesame-agent-events` into a `SecurityNotice` (ADR 0150 §5, ADR 0080),
//! appended as one JSON line to the notices file the daemon's Settings route
//! reads.
//!
//! - The conversion vets every field; this sink adds one more fence and drops
//!   any line that still names the surrogate marker, in any case. A notice
//!   that could carry a surrogate is not written at all.
//! - The file is `0600` in a `0700` directory, and capped: past
//!   [`MAX_NOTICES_BYTES`] the file is rotated to `notices.jsonl.1`, replacing
//!   the previous one, so a flood of guesses costs at most two caps of disk.
//! - Refusals arrive on the request path, so they are handed to one writer
//!   thread over a channel and the request never waits on the disk.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::thread::JoinHandle;

use chrono::Utc;
use opensesame_agent_events::{surrogate_refusal_notice, SurrogateRefusalReport};
use opensesame_invoke_through::Refusal;
use opensesame_plugin_settings::NOTICES_ROTATED_FILE;

use crate::ports::RefusalSink;

/// The notices file's cap before rotation.
pub const MAX_NOTICES_BYTES: u64 = 1024 * 1024;

/// One notice as a JSON line, or `None` when it must not be written.
#[must_use]
pub fn notice_line(refusal: &Refusal) -> Option<String> {
    let report = SurrogateRefusalReport {
        code: refusal.code.as_str(),
        run_id: refusal.run_id.as_deref(),
        provider_id: refusal.provider_id.as_deref(),
        detail: refusal.detail.as_deref(),
        organization_id: None,
        occurred_at: Utc::now(),
    };
    let notice = surrogate_refusal_notice(&report).ok()?;
    let line = serde_json::to_string(&notice).ok()?;
    (!names_marker(&line)).then_some(line)
}

/// Whether `text` contains the surrogate marker in any case.
#[must_use]
pub fn names_marker(text: &str) -> bool {
    text.to_ascii_lowercase().contains("osr_")
}

/// A [`RefusalSink`] that appends notices to a file from its own thread.
pub struct NoticeLog {
    sender: Mutex<Option<Sender<String>>>,
    writer: Mutex<Option<JoinHandle<()>>>,
}

impl std::fmt::Debug for NoticeLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NoticeLog").finish_non_exhaustive()
    }
}

impl NoticeLog {
    /// Start the writer for `path`, creating its directory `0700`.
    ///
    /// # Errors
    ///
    /// When the directory cannot be created.
    pub fn open(path: &Path) -> std::io::Result<Self> {
        if let Some(dir) = path.parent() {
            create_private_dir(dir)?;
        }
        let (sender, receiver) = mpsc::channel::<String>();
        let path = path.to_path_buf();
        let writer = std::thread::spawn(move || {
            for line in receiver {
                // A write that fails drops that notice; the proxy keeps
                // refusing, and the next notice tries again.
                let _ = append(&path, &line, MAX_NOTICES_BYTES);
            }
        });
        Ok(Self {
            sender: Mutex::new(Some(sender)),
            writer: Mutex::new(Some(writer)),
        })
    }

    /// Stop accepting notices and wait until every queued one is written.
    pub fn flush_and_close(&self) {
        drop(lock(&self.sender).take());
        if let Some(writer) = lock(&self.writer).take() {
            let _ = writer.join();
        }
    }
}

impl RefusalSink for NoticeLog {
    fn refused(&self, refusal: &Refusal) {
        let Some(line) = notice_line(refusal) else {
            return;
        };
        if let Some(sender) = lock(&self.sender).as_ref() {
            let _ = sender.send(line);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Append one line, rotating first when it would pass `cap`.
///
/// # Errors
///
/// When the file cannot be opened, rotated or written.
pub fn append(path: &Path, line: &str, cap: u64) -> std::io::Result<()> {
    let len = std::fs::metadata(path).map_or(0, |meta| meta.len());
    let added = u64::try_from(line.len())
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    if len > 0 && len.saturating_add(added) > cap {
        std::fs::rename(path, rotated(path))?;
    }
    let mut file = private_append(path)?;
    file.write_all(line.as_bytes())?;
    file.write_all(b"\n")
}

fn rotated(path: &Path) -> PathBuf {
    path.with_file_name(NOTICES_ROTATED_FILE)
}

fn private_append(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Create `dir` (and parents) owner-only.
///
/// # Errors
///
/// When the directory cannot be created.
pub fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

#[cfg(test)]
#[path = "notices_tests.rs"]
mod tests;
