//! Bounded original encrypted Node projection DATA. No root key or owner authority.
use super::{gate, refused, HeldPrivateRead, NativeNodeDataWriter, PrivateDirectory};
use std::{ffi::OsStr, io, path::Path, sync::Arc};
const LIMIT: usize = 3 * 1024 * 1024;
fn collect(
    directory: &Arc<PrivateDirectory>,
    prefix: &str,
    depth: usize,
    bytes: &mut usize,
    output: &mut Vec<(String, Vec<u8>)>,
) -> io::Result<()> {
    if depth > 8 {
        return Err(refused());
    }
    let before = directory.original_bounded_directory_entries(512)?;
    for (name, child) in &before {
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if prefix.is_empty() && name == "opensesame-generation.v1.json" {
            continue;
        }
        if *child {
            let nested = Arc::new(directory.open_child(Path::new(name))?);
            collect(&nested, &relative, depth + 1, bytes, output)?;
            nested.validate_original()?;
        } else {
            if Path::new(name).extension() != Some(OsStr::new("json")) || output.len() >= 512 {
                return Err(refused());
            }
            let mut held = HeldPrivateRead::open(Arc::clone(directory), Path::new(name), LIMIT)?;
            held.validate()?;
            *bytes = bytes.checked_add(held.bytes().len()).ok_or_else(refused)?;
            if *bytes > LIMIT {
                return Err(refused());
            }
            output.push((relative, held.bytes().to_vec()));
            held.validate()?;
        }
    }
    directory.validate_original()?;
    if before != directory.original_bounded_directory_entries(512)? {
        return Err(refused());
    }
    Ok(())
}
pub(super) fn projection(directory: &Arc<PrivateDirectory>) -> io::Result<Vec<(String, Vec<u8>)>> {
    let mut output = Vec::new();
    collect(directory, "", 0, &mut 0, &mut output)?;
    output.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(output)
}
impl NativeNodeDataWriter {
    /// Read a bounded exact encrypted header/projection under original CRED/BODY custody.
    /// # Errors
    /// Refuses changed/unsafe files, excessive depth/bytes/names and unsupported layout.
    pub fn read_authentication_projection(&self) -> io::Result<Vec<(String, Vec<u8>)>> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        let result = projection(&self.vault)?;
        self.check()?;
        Ok(result)
    }
}
impl NativeNodeDataWriter {
    /// Publish exact ciphertext header bytes under the original ordered writer custody.
    /// # Errors
    /// Refuses unsafe resources, byte conflicts and oversized/empty ciphertext documents.
    pub fn publish_authentication_header(&self, expected: &[u8], next: &[u8]) -> io::Result<()> {
        if expected.is_empty() || next.is_empty() || expected.len() > 65536 || next.len() > 65536 {
            return Err(refused());
        }
        self.compare_publish(
            super::NativeNodeDataScope::Vault,
            Path::new("header.json"),
            Some(expected),
            Some(next),
        )
    }
    /// Publish fresh copy-on-write encrypted documents followed by the exact manifest commit point.
    /// # Errors
    /// Refuses an altered original projection, invalid paths/order, conflicts or unsafe physical resources.
    pub fn publish_authentication_projection(
        &self,
        expected: &[(String, Vec<u8>)],
        writes: &[(String, Vec<u8>)],
    ) -> io::Result<()> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        if projection(&self.vault)? != expected
            || writes.is_empty()
            || writes.len() > 512
            || writes.last().map(|v| v.0.as_str()) != Some("vault.json")
        {
            return Err(refused());
        }
        let stages = Arc::new(
            self.credential
                .state
                .root
                .create_child(Path::new("vault-native-stages-v1"))?,
        );
        let mut total = 0usize;
        let mut used = std::collections::BTreeSet::new();
        for (index, (path, bytes)) in writes.iter().enumerate() {
            total = total.checked_add(bytes.len()).ok_or_else(refused)?;
            if total > LIMIT || bytes.is_empty() || !used.insert(path) {
                return Err(refused());
            }
            let manifest = index + 1 == writes.len();
            if !manifest
                && (!path.starts_with("secrets/generation-")
                    || Path::new(path).extension() != Some(OsStr::new("json"))
                    || path[8..].contains('/'))
            {
                return Err(refused());
            }
        }
        for (path, bytes) in writes {
            self.check()?;
            let (directory, leaf) = if path == "vault.json" {
                (Arc::clone(&self.vault), "vault.json")
            } else {
                (
                    Arc::new(self.vault.create_child(Path::new("secrets"))?),
                    &path[8..],
                )
            };
            let previous = expected
                .iter()
                .find(|(name, _)| name == path)
                .map(|(_, data)| data.as_slice());
            if path != "vault.json" && previous.is_some() {
                return Err(refused());
            }
            #[cfg(unix)]
            super::super::unix_private_files::compare_publish(
                &directory,
                &stages,
                Path::new(leaf),
                previous,
                Some(bytes),
                || self.check(),
            )?;
            #[cfg(windows)]
            super::super::windows_private_files::compare_publish(
                &directory,
                &stages,
                Path::new(leaf),
                previous,
                Some(bytes),
                || self.check(),
            )?;
            directory.validate_original()?;
        }
        self.check()
    }
}
