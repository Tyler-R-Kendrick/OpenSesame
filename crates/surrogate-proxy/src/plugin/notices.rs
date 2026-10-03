//! Where the plugin's tripwires go: every refusal, converted by
//! `opensesame-agent-events` into a `SecurityNotice` (ADR 0150 §5, ADR 0080),
//! appended as one JSON line to the notices file the daemon's Settings route
//! reads.
//!
//! - The conversion vets every field; this sink adds one more fence and drops
//!   any line that still names the surrogate marker, in any case. A notice
//!   that could carry a surrogate is not written at all.
//! - The files are `0600` in a `0700` directory. Refusals that are only
//!   noise (`surrogate.unknown`, `surrogate.expired`, the fallbacks) go to
//!   `notices.jsonl`, capped: past [`MAX_NOTICES_BYTES`] it is rotated to
//!   `notices.jsonl.1`, replacing the previous one. A refusal that is
//!   evidence (Error severity and up: `surrogate.misdirected`, `.revoked`,
//!   foreign caller) goes to `tripwires.jsonl`, which noise can never rotate
//!   away: it has its own cap, and once full it drops the newest rather than
//!   erase the oldest.
//! - Each `(code, run, provider, detail)` is written **once** per run, and
//!   noise is rate-limited, so a child that sends thousands of forged
//!   surrogates leaves one line, not thousands, and cannot push a tripwire
//!   out of anyone's view.
//! - Refusals arrive on the request path, so they are handed to one writer
//!   thread over a bounded channel (a full queue drops the notice, never
//!   blocks the request), and the request never waits on the disk.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::Instant;

use chrono::Utc;
use opensesame_agent_events::{surrogate_refusal_notice, SurrogateRefusalReport};
use opensesame_invoke_through::Refusal;
use opensesame_plugin_settings::{NOTICES_ROTATED_FILE, TRIPWIRES_FILE};

use crate::ports::{LoginRefusal, RefusalSink};

/// The notices file's cap before rotation.
pub const MAX_NOTICES_BYTES: u64 = 1024 * 1024;

/// The tripwires file's cap. It is never rotated; past it new lines are
/// dropped, so the first evidence of a run is the evidence that survives.
pub const MAX_TRIPWIRE_BYTES: u64 = 512 * 1024;

/// Notices queued for the writer before new ones are dropped.
const QUEUE: usize = 1024;
/// Distinct noise keys remembered per run; past it noise is dropped.
const MAX_NOISE_KEYS: usize = 1024;
/// Distinct tripwire keys remembered per run.
const MAX_TRIPWIRE_KEYS: usize = 256;
/// Noise lines per second, after a burst of [`NOISE_BURST`].
const NOISE_PER_SEC: f64 = 20.0;
const NOISE_BURST: f64 = 50.0;

/// One notice as a JSON line, or `None` when it must not be written.
#[must_use]
pub fn notice_line(refusal: &Refusal) -> Option<String> {
    vetted(refusal).map(|v| v.text)
}

fn vetted(refusal: &Refusal) -> Option<Vetted> {
    line_of(
        refusal.code.as_str(),
        refusal.run_id.as_deref(),
        refusal.provider_id.as_deref(),
        refusal.detail.as_deref(),
    )
}

/// A notice line with what the sink needs to decide whether to write it.
struct Vetted {
    text: String,
    /// `(code, run, provider, detail)`: one line per key per run.
    key: String,
    /// Error severity or above: evidence, not noise.
    evidence: bool,
}

/// A refused login-form surrogate as a JSON line. Only the codes the feed
/// knows are written: `misdirected` and `misplaced`, the tripwires, and
/// `revoked` and `ambiguous`. A login shape substitution does not fit
/// (`unsupported`, `absent`, `replayed`) falls back and is not a tripwire.
#[must_use]
pub fn login_notice_line(refusal: &LoginRefusal<'_>) -> Option<String> {
    login_vetted(refusal).map(|v| v.text)
}

fn login_vetted(refusal: &LoginRefusal<'_>) -> Option<Vetted> {
    line_of(refusal.code, Some(refusal.run_id), None, refusal.detail)
}

fn line_of(
    code: &str,
    run_id: Option<&str>,
    provider_id: Option<&str>,
    detail: Option<&str>,
) -> Option<Vetted> {
    let report = SurrogateRefusalReport {
        code,
        run_id,
        provider_id,
        detail,
        organization_id: None,
        occurred_at: Utc::now(),
    };
    let notice = surrogate_refusal_notice(&report).ok()?;
    let text = serde_json::to_string(&notice).ok()?;
    if names_marker(&text) {
        return None;
    }
    let evidence = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("severity").and_then(|s| s.as_str().map(str::to_owned)))
        .is_some_and(|severity| matches!(severity.as_str(), "error" | "critical"));
    // The key is built from the vetted notice's own fields, never from the
    // raw inputs, so a surrogate in a detail cannot make a distinct key.
    let key = format!("{code}|{}|{}", run_id.unwrap_or(""), provider_id.unwrap_or(""));
    let key = format!("{key}|{}", detail_shape(detail));
    Some(Vetted {
        text,
        key,
        evidence,
    })
}

/// The detail as a key: an `osr_` value collapses to one shape so forged
/// surrogates that differ only in their random part are one key.
fn detail_shape(detail: Option<&str>) -> String {
    match detail {
        Some(d) if names_marker(d) => "<marker>".to_owned(),
        Some(d) => d.chars().take(128).collect(),
        None => String::new(),
    }
}

/// Whether `text` contains the surrogate marker in any case.
#[must_use]
pub fn names_marker(text: &str) -> bool {
    text.to_ascii_lowercase().contains("osr_")
}

/// A [`RefusalSink`] that appends notices to files from its own thread.
pub struct NoticeLog {
    sender: Mutex<Option<SyncSender<Line>>>,
    writer: Mutex<Option<JoinHandle<()>>>,
    admission: Mutex<Admission>,
}

/// One line on its way to the writer.
struct Line {
    text: String,
    evidence: bool,
}

/// What has been written this run, and how fast noise may go on.
struct Admission {
    noise: HashSet<String>,
    evidence: HashSet<String>,
    tokens: f64,
    at: Instant,
}

impl Admission {
    fn new() -> Self {
        Self {
            noise: HashSet::new(),
            evidence: HashSet::new(),
            tokens: NOISE_BURST,
            at: Instant::now(),
        }
    }

    fn admit(&mut self, line: &Vetted) -> bool {
        if line.evidence {
            return self.evidence.len() < MAX_TRIPWIRE_KEYS
                && self.evidence.insert(line.key.clone());
        }
        let now = Instant::now();
        let elapsed = now.duration_since(self.at).as_secs_f64();
        self.at = now;
        self.tokens = elapsed.mul_add(NOISE_PER_SEC, self.tokens).min(NOISE_BURST);
        if self.tokens < 1.0 || self.noise.len() >= MAX_NOISE_KEYS || self.noise.contains(&line.key)
        {
            return false;
        }
        self.tokens -= 1.0;
        self.noise.insert(line.key.clone())
    }
}

impl std::fmt::Debug for NoticeLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NoticeLog").finish_non_exhaustive()
    }
}

impl NoticeLog {
    /// Start the writer for `path` (and the tripwires file beside it),
    /// creating the directory `0700`.
    ///
    /// # Errors
    ///
    /// When the directory cannot be created.
    pub fn open(path: &Path) -> std::io::Result<Self> {
        if let Some(dir) = path.parent() {
            create_private_dir(dir)?;
        }
        let (sender, receiver) = mpsc::sync_channel::<Line>(QUEUE);
        let path = path.to_path_buf();
        let tripwires = path.with_file_name(TRIPWIRES_FILE);
        let writer = std::thread::spawn(move || {
            for line in receiver {
                // A write that fails drops that notice; the proxy keeps
                // refusing, and the next notice tries again.
                let _ = if line.evidence {
                    append_capped(&tripwires, &line.text, MAX_TRIPWIRE_BYTES)
                } else {
                    append(&path, &line.text, MAX_NOTICES_BYTES)
                };
            }
        });
        Ok(Self {
            sender: Mutex::new(Some(sender)),
            writer: Mutex::new(Some(writer)),
            admission: Mutex::new(Admission::new()),
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

impl NoticeLog {
    fn queue(&self, line: Option<Vetted>) {
        let Some(line) = line else {
            return;
        };
        if !lock(&self.admission).admit(&line) {
            return;
        }
        if let Some(sender) = lock(&self.sender).as_ref() {
            let _ = sender.try_send(Line {
                text: line.text,
                evidence: line.evidence,
            });
        }
    }
}

impl RefusalSink for NoticeLog {
    fn refused(&self, refusal: &Refusal) {
        self.queue(vetted(refusal));
    }

    fn login_refused(&self, refusal: &LoginRefusal<'_>) {
        self.queue(login_vetted(refusal));
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

/// Append one line unless the file would pass `cap`: evidence is never
/// rotated away, so a full file drops the newest line instead.
///
/// # Errors
///
/// When the file cannot be opened or written.
pub fn append_capped(path: &Path, line: &str, cap: u64) -> std::io::Result<()> {
    let len = std::fs::metadata(path).map_or(0, |meta| meta.len());
    let added = u64::try_from(line.len())
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    if len.saturating_add(added) > cap {
        return Ok(());
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
