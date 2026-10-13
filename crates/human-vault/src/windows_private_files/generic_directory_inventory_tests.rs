//! Genuine Windows original-handle bounded census controls, authored unexecuted.
use super::*;
use crate::root_protection::windows_private_files::write_new;
use std::path::Path;
#[test]
fn generic_transport_budget_does_not_weaken_native_generation_budget() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("original-private");
    let directory = PrivateDirectory::create_new(&root).unwrap();
    for n in 0..129 {
        write_new(
            &directory,
            Path::new(&format!("record-{n:03}.json")),
            b"opaque physical data",
        )
        .unwrap();
    }
    assert!(directory.original_directory_entries().is_err());
    for _ in 0..2 {
        let actual = directory.original_bounded_directory_entries(129).unwrap();
        assert_eq!(actual.len(), 129);
        assert_eq!(actual.first().unwrap(), &("record-000.json".into(), false));
        assert_eq!(actual.last().unwrap(), &("record-128.json".into(), false));
    }
    assert!(directory.original_bounded_directory_entries(128).is_err());
    assert!(directory.original_bounded_directory_entries(0).is_err());
    assert!(directory.original_bounded_directory_entries(4097).is_err());
}

fn encoded_directory_row(name: &str) -> Vec<u64> {
    let mut bytes = vec![0u8; 65536];
    let units: Vec<u16> = name.encode_utf16().collect();
    let length = u32::try_from(units.len() * 2).unwrap();
    let field = mem::offset_of!(FILE_ID_BOTH_DIR_INFO, FileNameLength);
    bytes[field..field + 4].copy_from_slice(&length.to_ne_bytes());
    let field = mem::offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
    for (index, unit) in units.iter().enumerate() {
        bytes[field + index * 2..field + index * 2 + 2].copy_from_slice(&unit.to_ne_bytes());
    }
    bytes
        .chunks_exact(8)
        .map(|word| u64::from_ne_bytes(word.try_into().unwrap()))
        .collect()
}

#[test]
fn directory_row_variable_tail_is_read_from_original_buffer() {
    let name = "long-original-ciphertext-😀.json";
    let buffer = encoded_directory_row(name);
    let mut rows = Vec::new();
    consume_directory_rows(&buffer, &mut rows, 128).unwrap();
    assert_eq!(rows, vec![(name.to_owned(), false)]);
}

#[test]
fn directory_row_misaligned_successor_is_refused() {
    let mut buffer = encoded_directory_row("original.json");
    let mut first = buffer[0].to_ne_bytes();
    first[..4].copy_from_slice(&7u32.to_ne_bytes());
    buffer[0] = u64::from_ne_bytes(first);
    assert!(consume_directory_rows(&buffer, &mut Vec::new(), 128).is_err());
}
