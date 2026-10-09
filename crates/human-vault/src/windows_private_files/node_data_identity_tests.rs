//! Exact actual Windows handle OS fields; Node/libuv runtime comparison remains mandatory elsewhere.
use super::*;
use std::{fs, mem, os::windows::io::AsRawHandle, path::Path};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
};
#[test]
fn node_numeric_pair_is_full_actual_volume_serial_file_index_and_native_binding_remains_unchanged()
{
    let temp = tempfile::tempdir().unwrap();
    let parent = fs::canonicalize(temp.path()).unwrap();
    let path = Path::new(parent.to_str().unwrap().strip_prefix(r"\\?\").unwrap()).join("identity");
    let root = PrivateDirectory::create_new(&path).unwrap();
    // SAFETY: Windows documented output structure is valid zero-initialized and writable.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { mem::zeroed() };
    // SAFETY: owned original live directory handle and correctly sized output remain owned.
    assert_ne!(
        unsafe {
            GetFileInformationByHandle(root.root_handle().unwrap().as_raw_handle(), &mut info)
        },
        0
    );
    let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    let expected = format!("{}:{index}", info.dwVolumeSerialNumber);
    assert_eq!(root.original_node_data_identity().unwrap(), expected);
    let parts: Vec<_> = expected.split(':').collect();
    assert_eq!(parts.len(), 2);
    assert!(parts
        .iter()
        .all(|part| part.len() <= 32 && part.bytes().all(|b| b.is_ascii_digit())));
    assert_eq!(
        root.original_resource_identity().unwrap(),
        format!(
            "windows:{}:{}:{}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        )
    );
    assert_eq!(root.original_node_data_identity().unwrap(), expected);
}
