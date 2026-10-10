//! Bounded directory enumeration on the retained original Windows kernel handle.
use super::{handles, security, PrivateDirectory};
use std::{fs::File, io, mem, os::windows::io::AsRawHandle};
use windows_sys::Win32::{
    Foundation::ERROR_NO_MORE_FILES,
    Storage::FileSystem::{
        FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, GetFileInformationByHandleEx,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ID_BOTH_DIR_INFO,
        FILE_INFO_BY_HANDLE_CLASS,
    },
};
impl PrivateDirectory {
    /// Bounded actual child names/type bits from this original directory handle.
    /// Resource metadata only; no descriptor, keys or owner authority leave this scope.
    /// # Errors
    /// Refuses changed provenance, unsupported/reparse nodes, invalid names or enumeration bounds.
    pub fn original_directory_entries(&self) -> io::Result<Vec<(String, bool)>> {
        self.original_bounded_directory_entries(128)
    }
    /// Bounded actual generic ciphertext DATA census; native callers keep the strict128 wrapper.
    /// # Errors
    /// Refuses zero/over4096, changed original handles, unsafe nodes and malformed rows.
    pub fn original_bounded_directory_entries(
        &self,
        maximum: usize,
    ) -> io::Result<Vec<(String, bool)>> {
        if maximum == 0 || maximum > 4096 {
            return Err(security::refused());
        }
        self.validate()?;
        let mut buffer = vec![0u64; 8192]; // aligned64KiB, no caller-controlled allocation.
        let mut result = Vec::new();
        let mut class = FileIdBothDirectoryRestartInfo;
        loop {
            self.validate()?;
            buffer.fill(0);
            if !read_directory_batch(self.root_handle()?, class, &mut buffer)? {
                break;
            }
            class = FileIdBothDirectoryInfo;
            consume_directory_rows(&buffer, &mut result, maximum)?;
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

fn read_directory_batch(
    file: &File,
    class: FILE_INFO_BY_HANDLE_CLASS,
    buffer: &mut [u64],
) -> io::Result<bool> {
    if buffer.len() != 8192 {
        return Err(security::refused());
    }
    // SAFETY: live retained directory handle and aligned owned64KiB buffer remain valid.
    let read = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            class,
            buffer.as_mut_ptr().cast(),
            65536,
        )
    };
    if read != 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error
        .raw_os_error()
        .is_some_and(|code| u32::try_from(code) == Ok(ERROR_NO_MORE_FILES))
    {
        return Ok(false);
    }
    Err(error)
}

fn consume_directory_rows(
    buffer: &[u64],
    result: &mut Vec<(String, bool)>,
    maximum: usize,
) -> io::Result<()> {
    if buffer.len() != 8192 {
        return Err(security::refused());
    }
    let mut offset = 0usize;
    loop {
        if offset > 65536 - mem::size_of::<FILE_ID_BOTH_DIR_INFO>() || offset % 8 != 0 {
            return Err(security::refused());
        }
        // SAFETY: the entire header is bounded inside the owned u64 allocation.
        // Copy the header without forming a reference to a variable-length Windows row.
        let row = unsafe {
            std::ptr::read_unaligned(
                buffer
                    .as_ptr()
                    .add(offset / 8)
                    .cast::<FILE_ID_BOTH_DIR_INFO>(),
            )
        };
        let bytes = row.FileNameLength as usize;
        let name_offset = mem::offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
        if bytes == 0
            || bytes % 2 != 0
            || bytes > 510
            || name_offset % 2 != 0
            || offset + name_offset + bytes > 65536
            || row.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(security::refused());
        }
        // SAFETY: variableUTF16 tail length/alignment checked against complete owned buffer.
        let units = unsafe {
            std::slice::from_raw_parts(
                buffer
                    .as_ptr()
                    .cast::<u16>()
                    .add((offset + name_offset) / 2),
                bytes / 2,
            )
        };
        let name = String::from_utf16(units).map_err(|_| security::refused())?;
        if name != "." && name != ".." {
            handles::component_policy(&name)?;
            result.push((name, row.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0));
            if result.len() > maximum {
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
    Ok(())
}

#[cfg(test)]
#[path = "generic_directory_inventory_tests.rs"]
mod tests;
