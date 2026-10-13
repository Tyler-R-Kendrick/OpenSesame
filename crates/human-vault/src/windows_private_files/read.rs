//! Bounded original reads retained through actual Windows kernel handles.
use super::{handles, security, PrivateDirectory};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    mem,
    os::windows::io::AsRawHandle,
    path::{Component, Path},
    ptr,
    sync::Arc,
};
use windows_sys::Win32::{
    Foundation::GENERIC_READ,
    Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, OPEN_EXISTING,
        READ_CONTROL,
    },
};
use zeroize::Zeroizing;

struct Parent {
    file: File,
    identity: handles::Identity,
    name: String,
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct Version {
    size: u64,
    created: u64,
    written: u64,
}
fn version(file: &File) -> io::Result<Version> {
    // SAFETY: zeroed Windows output buffer is valid for this API.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
    // SAFETY: the retained File and correctly sized writable output remain live.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &raw mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Version {
        size: (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow),
        created: (u64::from(info.ftCreationTime.dwHighDateTime) << 32)
            | u64::from(info.ftCreationTime.dwLowDateTime),
        written: (u64::from(info.ftLastWriteTime.dwHighDateTime) << 32)
            | u64::from(info.ftLastWriteTime.dwLowDateTime),
    })
}
fn file(path: &Path) -> io::Result<File> {
    let path = handles::wide(path)?;
    // SAFETY: terminated retained path; final reparse nodes are never followed.
    // Denying write/delete sharing prevents a conflicting writable/replacement handle
    // before or during this read. No inherited handle or caller descriptor is accepted.
    let raw = unsafe {
        CreateFileW(
            path.as_ptr(),
            GENERIC_READ | READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            ptr::null_mut(),
        )
    };
    handles::owned(raw)
}

/// Original private bytes and all selected actual ancestor/file handles.
/// This object establishes only a filesystem profile, never credential authentication.
pub struct HeldPrivateRead {
    root: Arc<PrivateDirectory>,
    parents: Vec<Parent>,
    file: File,
    name: String,
    identity: handles::Identity,
    version: Version,
    bytes: Zeroizing<Vec<u8>>,
}
impl HeldPrivateRead {
    /// Open only a bounded relative existing private file beneath this exact original root.
    /// # Errors
    /// Refuses unsafe names, reparse/hardlinked/broad nodes, conflicting writers or limits.
    pub fn open(root: Arc<PrivateDirectory>, relative: &Path, limit: usize) -> io::Result<Self> {
        if limit == 0 || limit > 16 * 1024 * 1024 {
            return Err(security::refused());
        }
        root.validate()?;
        let names = components(relative)?;
        let name = names.last().ok_or_else(security::refused)?.clone();
        let mut path = root.paths.last().ok_or_else(security::refused)?.clone();
        let mut parents: Vec<Parent> = Vec::new();
        for name in &names[..names.len() - 1] {
            path.push(name);
            checked_length(&path)?;
            let opened = handles::directory(&path)?;
            let parent = parents
                .last()
                .map_or(root.root_handle()?, |value| &value.file);
            handles::child_relation(parent, &opened, name)?;
            security::verify(&opened, &root.owner, true)?;
            parents.push(Parent {
                identity: handles::identity(&opened, true)?,
                file: opened,
                name: name.clone(),
            });
        }
        path.push(&name);
        checked_length(&path)?;
        let opened = file(&path)?;
        let mut result = Self {
            identity: handles::identity(&opened, false)?,
            version: version(&opened)?,
            root,
            parents,
            file: opened,
            name,
            bytes: Zeroizing::new(Vec::new()),
        };
        result.validate_nodes()?;
        if result.version.size > u64::try_from(limit).map_err(|_| security::refused())? {
            return Err(security::refused());
        }
        let count = u64::try_from(limit + 1).map_err(|_| security::refused())?;
        (&mut result.file)
            .take(count)
            .read_to_end(&mut result.bytes)?;
        if result.bytes.len() > limit
            || u64::try_from(result.bytes.len()).map_err(|_| security::refused())?
                != result.version.size
        {
            return Err(security::refused());
        }
        result.validate()?;
        Ok(result)
    }
    fn validate_nodes(&self) -> io::Result<()> {
        self.root.validate()?;
        let mut parent = self.root.root_handle()?;
        for held in &self.parents {
            if handles::identity(&held.file, true)? != held.identity {
                return Err(security::refused());
            }
            security::verify(&held.file, &self.root.owner, true)?;
            handles::child_relation(parent, &held.file, &held.name)?;
            parent = &held.file;
        }
        if handles::identity(&self.file, false)? != self.identity
            || version(&self.file)? != self.version
        {
            return Err(security::refused());
        }
        security::verify(&self.file, &self.root.owner, false)?;
        handles::child_relation(parent, &self.file, &self.name)
    }
    /// Read-only snapshot bytes; no writable handle or real credential/root authority.
    #[must_use]
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    /// Revalidate retained root/nodes and exact bytes before accepting a consumer effect.
    /// # Errors
    /// Refuses changed identity/ACL/parent/content or unsupported physical state.
    pub fn validate(&mut self) -> io::Result<()> {
        self.validate_nodes()?;
        self.file.seek(SeekFrom::Start(0))?;
        let mut bytes = Zeroizing::new(Vec::new());
        let bound = u64::try_from(self.bytes.len() + 1).map_err(|_| security::refused())?;
        (&mut self.file).take(bound).read_to_end(&mut bytes)?;
        if *bytes != *self.bytes {
            return Err(security::refused());
        }
        self.validate_nodes()
    }
}
fn checked_length(path: &Path) -> io::Result<()> {
    if path
        .to_str()
        .ok_or_else(security::refused)?
        .encode_utf16()
        .count()
        > 32760
    {
        return Err(security::refused());
    }
    Ok(())
}
fn components(relative: &Path) -> io::Result<Vec<String>> {
    let text = relative.to_str().ok_or_else(security::refused)?;
    for component in text.split(['\\', '/']) {
        handles::component_policy(component)?;
    }
    let mut names = Vec::new();
    for component in relative.components() {
        let Component::Normal(value) = component else {
            return Err(security::refused());
        };
        let name = value.to_str().ok_or_else(security::refused)?;
        handles::component_policy(name)?;
        names.push(name.to_owned());
        if names.len() > 128 {
            return Err(security::refused());
        }
    }
    if names.is_empty() {
        return Err(security::refused());
    }
    Ok(names)
}

#[cfg(test)]
#[path = "read_tests.rs"]
mod read_tests;

#[cfg(test)]
#[path = "journal_read_tests.rs"]
mod journal_read_tests;
