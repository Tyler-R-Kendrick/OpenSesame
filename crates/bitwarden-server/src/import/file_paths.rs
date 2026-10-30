//! Admission for untrusted source IDs used in import URLs and local paths.

use std::fs::File;
use std::io::Read as _;

/// The same intake bound applies to local archives and live downloads.
pub(super) const MAX_FILE_BYTES: usize = 500 * 1024 * 1024;

pub(super) fn read_file(file: File, limit: usize) -> Option<Vec<u8>> {
    let metadata = file.metadata().ok()?;
    let limit_u64 = u64::try_from(limit).ok()?;
    if !metadata.is_file() || metadata.len() > limit_u64 {
        return None;
    }
    read_bounded(file, limit)
}

fn read_bounded(reader: impl std::io::Read, limit: usize) -> Option<Vec<u8>> {
    let bound = u64::try_from(limit).ok()?.checked_add(1)?;
    let mut bytes = Vec::new();
    reader.take(bound).read_to_end(&mut bytes).ok()?;
    (bytes.len() <= limit).then_some(bytes)
}

/// Bitwarden file/cipher IDs are opaque ASCII identifiers, never path syntax.
/// Reject percent escapes too: an ID is also interpolated into an API URL.
pub(super) fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(unix)]
pub(super) fn read_confined(directory: &File, components: &[String]) -> Option<Vec<u8>> {
    use std::os::unix::fs::MetadataExt as _;

    use rustix::fs::{openat, Mode, OFlags};

    // Recheck even publicly constructed FileSource::Confined values.
    if !components.iter().all(|part| safe_component(part)) {
        return None;
    }
    let (leaf, parents) = components.split_last()?;
    let mut parent = directory.try_clone().ok()?;
    for component in parents {
        parent = File::from(
            openat(
                &parent,
                component.as_str(),
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .ok()?,
        );
    }
    let file = File::from(
        openat(
            &parent,
            leaf.as_str(),
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .ok()?,
    );
    let metadata = file.metadata().ok()?;
    // An archive hardlink can name an unrelated local file just like a symlink.
    if !metadata.is_file() || metadata.nlink() != 1 {
        return None;
    }
    read_file(file, MAX_FILE_BYTES)
}

#[cfg(not(unix))]
pub(super) fn read_confined(_directory: &File, _components: &[String]) -> Option<Vec<u8>> {
    // No descriptor-relative no-follow reader is available on this target.
    None
}

#[cfg(test)]
#[path = "file_paths_tests.rs"]
mod tests;
