//! Owner-only files, created without a moment where they are anything else.

#[cfg(unix)]
#[path = "private_file_unix.rs"]
mod unix;
#[cfg(unix)]
pub(crate) use unix::{write_private, write_private_new};

/// Write a file only its owner can read, without a moment where it is anything else.
///
/// `fs::write` then `set_permissions` creates the file at the umask's mode first,
/// so a token spends a window world-readable — long enough for another account on
/// the box to open it and keep the handle.
#[cfg(not(unix))]
pub(crate) fn write_private(path: &std::path::Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn write_private_new(path: &std::path::Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    opts.open(path)?.write_all(bytes)?;
    Ok(())
}
