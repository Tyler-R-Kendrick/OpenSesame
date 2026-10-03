//! Reading a sealed log back, and sealing one an older build wrote in the clear.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

use opensesame_redaction::redact_text;

use crate::file::rotated_path;
use crate::seal::{create_private, open_line, seal_line, LogKey, LINE_PREFIX};

/// What stands in for a sealed line that does not open.
pub const UNREADABLE: &str = "[sealed line: not readable with this key]";

fn lines_of(path: &Path) -> io::Result<Vec<String>> {
    match fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes)
            .lines()
            .map(str::to_owned)
            .collect()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

/// One stored line as text: a sealed line opened, or [`UNREADABLE`]; a line an
/// older build wrote in the clear is scrubbed rather than trusted.
fn present(key: &LogKey, line: &str) -> String {
    if line.starts_with(LINE_PREFIX) {
        open_line(key, line).unwrap_or_else(|| UNREADABLE.to_owned())
    } else {
        redact_text(line)
    }
}

/// The last `count` lines, oldest first, reaching back into the newest rotated
/// file when the live one is short.
///
/// # Errors
///
/// Returns an error when a log file exists but cannot be read.
pub fn read_tail(path: &Path, key: &LogKey, count: usize) -> io::Result<Vec<String>> {
    let mut lines = lines_of(path)?;
    if lines.len() < count {
        let mut older = lines_of(&rotated_path(path, 1))?;
        older.append(&mut lines);
        lines = older;
    }
    let skip = lines.len().saturating_sub(count);
    Ok(lines
        .iter()
        .skip(skip)
        .map(|line| present(key, line))
        .collect())
}

/// How many rotated generations beside the live file are looked for. Rotation
/// keeps a handful; the scan does not stop at a gap, so an odd history is sealed too.
const MAX_ROTATED_SCAN: u32 = 64;

/// Seal every line of `path` that an older build wrote in the clear, in place
/// and atomically (a sibling file is written owner-only, then renamed over),
/// and do the same for every rotated generation beside it (`path.1`, `path.2`,
/// ...). Already-sealed lines are left as they are. Returns how many were sealed.
///
/// # Errors
///
/// Returns an error when a file cannot be read or replaced; that file is
/// untouched in that case.
pub fn seal_existing(path: &Path, key: &LogKey) -> io::Result<usize> {
    let mut sealed = seal_one(path, key)?;
    for generation in 1..=MAX_ROTATED_SCAN {
        sealed += seal_one(&rotated_path(path, generation), key)?;
    }
    Ok(sealed)
}

fn seal_one(path: &Path, key: &LogKey) -> io::Result<usize> {
    let lines = lines_of(path)?;
    let legacy = lines
        .iter()
        .filter(|line| !line.is_empty() && !line.starts_with(LINE_PREFIX))
        .count();
    if legacy == 0 {
        return Ok(0);
    }
    let mut name = path.as_os_str().to_owned();
    name.push(".sealing");
    let staging = std::path::PathBuf::from(name);
    let _ = fs::remove_file(&staging);
    let mut out = create_private(&staging)?;
    for line in &lines {
        if line.is_empty() {
            continue;
        }
        let sealed = if line.starts_with(LINE_PREFIX) {
            line.clone()
        } else {
            seal_line(key, &redact_text(line))
        };
        writeln!(out, "{sealed}")?;
    }
    out.flush()?;
    out.sync_all()?;
    fs::rename(&staging, path)?;
    Ok(legacy)
}
