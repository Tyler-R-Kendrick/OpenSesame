//! Actual original Node key wire and private retained-file controls; no structural key grant.
use super::*;
#[cfg(unix)]
use crate::root_protection::unix_private_files::write_new;
#[cfg(windows)]
use crate::root_protection::windows_private_files::write_new;
use std::fs;
#[test]
fn actual_node_base64_key_with_one_optional_lf_decodes_and_all_other_wire_profiles_refuse() {
    let encoded = STANDARD.encode([41; 32]);
    for wire in [
        encoded.as_bytes().to_vec(),
        format!("{encoded}\n").into_bytes(),
    ] {
        assert_eq!(*decode_device_key_wire(&wire).unwrap(), [41; 32]);
    }
    for wire in [
        vec![41; 32],
        format!(" {encoded}").into_bytes(),
        format!("{encoded} ").into_bytes(),
        format!("{encoded}\r\n").into_bytes(),
        format!("{encoded}\n\n").into_bytes(),
        encoded.trim_end_matches('=').as_bytes().to_vec(),
        STANDARD.encode([41; 31]).into_bytes(),
        STANDARD.encode([41; 33]).into_bytes(),
        vec![255; 44],
    ] {
        assert!(decode_device_key_wire(&wire).is_err());
    }
    // The last sextet's unused bits must be canonical, not merely decode to the same bytes.
    let mut noncanonical = encoded.into_bytes();
    noncanonical[42] = b'l';
    assert!(decode_device_key_wire(&noncanonical).is_err());
}
#[test]
fn actual_raw_key_file_refuses_and_changed_genuine_encoded_original_key_retires_state() {
    let temp = tempfile::tempdir().unwrap();
    let parent = fs::canonicalize(temp.path()).unwrap();
    #[cfg(unix)]
    let path = parent.join("node-state");
    #[cfg(windows)]
    let path =
        Path::new(parent.to_str().unwrap().strip_prefix(r"\\?\").unwrap()).join("node-state");
    let root = Arc::new(PrivateDirectory::create_new(&path).unwrap());
    write_new(&root, Path::new("at-rest.key"), &[41; 32]).unwrap();
    assert!(NativeNodeDataState::capture(Arc::clone(&root)).is_err());
    fs::write(
        path.join("at-rest.key"),
        format!("{}\n", STANDARD.encode([41; 32])),
    )
    .unwrap();
    let original = NativeNodeDataState::capture(root).unwrap();
    original.validate().unwrap();
    fs::write(
        path.join("at-rest.key"),
        format!("{}\n", STANDARD.encode([42; 32])),
    )
    .unwrap();
    assert!(original.validate().is_err());
    assert!(original.credential_writer().is_err());
}
