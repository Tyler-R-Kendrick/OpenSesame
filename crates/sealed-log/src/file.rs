//! The sealed log file and the writer that feeds it.
//!
//! Every line is sealed before it is written; the file is created and kept
//! owner-only (a file that already exists with a wider mode is narrowed);
//! rotation renames whole files, so a reader never sees half a generation.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use crate::seal::{seal_line, LogKey};

/// Rotate when a file would pass this size.
pub const DEFAULT_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// Rotated generations kept beside the live file (`.1` newest).
pub const DEFAULT_KEEP: u32 = 3;

pub struct SealedLogFile {
    path: PathBuf,
    key: LogKey,
    file: File,
    len: u64,
    max_bytes: u64,
    keep: u32,
}

/// The name of the `generation`th rotated file: `daemon.log` → `daemon.log.1`.
#[must_use]
pub fn rotated_path(path: &Path, generation: u32) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{generation}"));
    PathBuf::from(name)
}

fn open_append(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    // `mode` applies only when the file is created; one that already exists,
    // written by an older build under a wider umask, is narrowed here.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

impl SealedLogFile {
    /// Open (creating if need be) the sealed log at `path`.
    ///
    /// # Errors
    ///
    /// Returns an error when the directory or file cannot be created or opened.
    pub fn open(path: &Path, key: LogKey) -> io::Result<Self> {
        Self::open_with(path, key, DEFAULT_MAX_BYTES, DEFAULT_KEEP)
    }

    /// As [`SealedLogFile::open`], with explicit rotation limits.
    ///
    /// # Errors
    ///
    /// Returns an error when the directory or file cannot be created or opened.
    pub fn open_with(path: &Path, key: LogKey, max_bytes: u64, keep: u32) -> io::Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let file = open_append(path)?;
        let len = file.metadata()?.len();
        Ok(Self {
            path: path.to_owned(),
            key,
            file,
            len,
            max_bytes,
            keep,
        })
    }

    fn rotate(&mut self) -> io::Result<()> {
        if self.keep == 0 {
            self.file.set_len(0)?;
            self.len = 0;
            return Ok(());
        }
        for generation in (1..self.keep).rev() {
            let from = rotated_path(&self.path, generation);
            if from.exists() {
                std::fs::rename(&from, rotated_path(&self.path, generation + 1))?;
            }
        }
        std::fs::rename(&self.path, rotated_path(&self.path, 1))?;
        self.file = open_append(&self.path)?;
        self.len = 0;
        Ok(())
    }

    /// Seal `line` (a trailing newline is dropped) and append it.
    ///
    /// # Errors
    ///
    /// Returns an error when the line cannot be written or the file rotated.
    pub fn append(&mut self, line: &str) -> io::Result<()> {
        let mut sealed = seal_line(&self.key, line.trim_end_matches(['\n', '\r']));
        sealed.push('\n');
        let needed = u64::try_from(sealed.len()).unwrap_or(u64::MAX);
        if self.len > 0 && self.len.saturating_add(needed) > self.max_bytes {
            self.rotate()?;
        }
        self.file.write_all(sealed.as_bytes())?;
        self.file.flush()?;
        self.len = self.len.saturating_add(needed);
        Ok(())
    }
}

/// A sink many writers share: cloning it shares the one file, so lines from
/// concurrent events interleave whole and rotation happens once.
#[derive(Clone)]
pub struct SealedLogSink {
    file: Arc<Mutex<SealedLogFile>>,
}

impl SealedLogSink {
    #[must_use]
    pub fn new(file: SealedLogFile) -> Self {
        Self {
            file: Arc::new(Mutex::new(file)),
        }
    }

    /// A writer over this sink, for one event.
    #[must_use]
    pub fn writer(&self) -> SealedLogWriter {
        SealedLogWriter {
            sink: self.clone(),
            pending: Vec::new(),
        }
    }

    fn append(&self, line: &str) -> io::Result<()> {
        self.file
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .append(line)
    }
}

/// An `io::Write` that seals each complete line it is given.
pub struct SealedLogWriter {
    sink: SealedLogSink,
    pending: Vec<u8>,
}

impl SealedLogWriter {
    fn drain_lines(&mut self) -> io::Result<()> {
        while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            self.sink.append(&String::from_utf8_lossy(&line))?;
        }
        Ok(())
    }
}

impl Write for SealedLogWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.pending.extend_from_slice(buf);
        self.drain_lines()?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for SealedLogWriter {
    /// An unterminated last line is still a line.
    fn drop(&mut self) {
        if !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            let _ = self.sink.append(&String::from_utf8_lossy(&line));
        }
    }
}
