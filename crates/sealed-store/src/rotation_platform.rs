//! Platform-specific private staging and confined publication.
use crate::StoreError;
#[cfg(not(windows))]
use std::fs;
use std::path::Path;

pub(super) fn create_private_dir(path: &Path) -> Result<(), StoreError> {
    #[cfg(windows)]
    {
        let parent = path
            .parent()
            .ok_or_else(|| StoreError::InvalidPath("missing directory parent".into()))?;
        let name = path
            .file_name()
            .ok_or_else(|| StoreError::InvalidPath("missing directory name".into()))?;
        opensesame_human_vault::windows_io::create_dir(parent, Path::new(name))
            .map_err(StoreError::Io)
    }
    #[cfg(not(windows))]
    create_private_dir_platform(path)
}

#[cfg(not(windows))]
fn create_private_dir_platform(path: &Path) -> Result<(), StoreError> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)?;
    Ok(())
}

pub(super) fn rename_confined(
    root: &Path,
    source: &Path,
    destination: &Path,
) -> Result<(), StoreError> {
    #[cfg(windows)]
    {
        let source = source
            .strip_prefix(root)
            .map_err(|_| StoreError::InvalidPath("source escapes store root".into()))?;
        let destination = destination
            .strip_prefix(root)
            .map_err(|_| StoreError::InvalidPath("destination escapes store root".into()))?;
        opensesame_human_vault::windows_publish::rename(root, source, destination)
            .map_err(StoreError::Io)
    }
    #[cfg(not(windows))]
    {
        let _ = root;
        fs::rename(source, destination).map_err(StoreError::Io)
    }
}
