//! Bounded directory enumeration on the retained original Windows kernel handle.
use super::{handles, security, PrivateDirectory};
use std::{io, mem, os::windows::io::AsRawHandle};
use windows_sys::Win32::{
    Foundation::ERROR_NO_MORE_FILES,
    Storage::FileSystem::{
        FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, GetFileInformationByHandleEx,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ID_BOTH_DIR_INFO,
    },
};
impl PrivateDirectory {
    /// Bounded actual child names/type bits from this original directory handle.
    /// Resource metadata only; no descriptor, keys or owner authority leave this scope.
    /// # Errors
    /// Refuses changed provenance, unsupported/reparse nodes, invalid names or enumeration bounds.
    pub fn original_directory_entries(&self) -> io::Result<Vec<(String, bool)>> {
        self.validate()?;
        let mut buffer = vec![0u64; 8192]; // aligned64KiB, no caller-controlled allocation.
        let mut result = Vec::new();
        let mut class = FileIdBothDirectoryRestartInfo;
        loop {
            self.validate()?;
            buffer.fill(0);
            // SAFETY: live retained directory handle and aligned owned64KiB buffer remain valid.
            let read = unsafe {
                GetFileInformationByHandleEx(
                    self.root_handle()?.as_raw_handle(),
                    class,
                    buffer.as_mut_ptr().cast(),
                    65536,
                )
            };
            if read == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                    break;
                }
                return Err(error);
            }
            class = FileIdBothDirectoryInfo;
            let mut offset = 0usize;
            loop {
                if offset > 65536 - mem::size_of::<FILE_ID_BOTH_DIR_INFO>() || offset % 8 != 0 {
                    return Err(security::refused());
                }
                // SAFETY: aligned offset and complete structure are bounded within owned buffer.
                let row = unsafe {
                    &*buffer
                        .as_ptr()
                        .cast::<u8>()
                        .add(offset)
                        .cast::<FILE_ID_BOTH_DIR_INFO>()
                };
                let bytes = row.FileNameLength as usize;
                let name_offset = mem::offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
                if bytes == 0
                    || bytes % 2 != 0
                    || bytes > 510
                    || offset + name_offset + bytes > 65536
                    || row.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
                {
                    return Err(security::refused());
                }
                // SAFETY: variableUTF16 tail length/alignment checked against complete owned buffer.
                let units = unsafe {
                    std::slice::from_raw_parts(
                        std::ptr::addr_of!(row.FileName).cast::<u16>(),
                        bytes / 2,
                    )
                };
                let name = String::from_utf16(units).map_err(|_| security::refused())?;
                if name != "." && name != ".." {
                    handles::component_policy(&name)?;
                    result.push((name, row.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0));
                    if result.len() > 128 {
                        return Err(security::refused());
                    }
                }
                if row.NextEntryOffset == 0 {
                    break;
                }
                let advance = row.NextEntryOffset as usize;
                if advance < name_offset + bytes || advance % 8 != 0 {
                    return Err(security::refused());
                }
                offset = offset.checked_add(advance).ok_or_else(security::refused)?;
            }
            self.validate()?;
        }
        self.validate()?;
        result.sort();
        if result.windows(2).any(|pair| pair[0].0 == pair[1].0) {
            return Err(security::refused());
        }
        Ok(result)
    }
}
