//! Owner-only files, created without a moment where they are anything else.

/// Write a file only its owner can read, without a moment where it is anything else.
///
/// `fs::write` then `set_permissions` creates the file at the umask's mode first,
/// so a token spends a window world-readable — long enough for another account on
/// the box to open it and keep the handle.
pub(crate) fn write_private(path: &std::path::Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // An existing file keeps its old mode, so say it again.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub(crate) fn write_private_new(path: &std::path::Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)?;
    Ok(())
}
