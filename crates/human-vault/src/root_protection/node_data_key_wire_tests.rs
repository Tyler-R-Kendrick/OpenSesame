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
    let original = NativeNodeDataState::capture(Arc::clone(&root)).unwrap();
    original.validate().unwrap();
    let next_wire = format!("{}\n", STANDARD.encode([42; 32]));
    #[cfg(unix)]
    {
        fs::write(path.join("at-rest.key"), &next_wire).unwrap();
        assert!(original.validate().is_err());
        assert!(original.credential_writer().is_err());
    }
    #[cfg(windows)]
    {
        // The genuine original read denies write/delete sharing. The conflicting operation
        // must fail before modifying the original file; weakening that protection is unsafe.
        let error = fs::write(path.join("at-rest.key"), &next_wire).unwrap_err();
        assert_eq!(error.raw_os_error(), Some(32)); // ERROR_SHARING_VIOLATION.
        assert_eq!(
            fs::read(path.join("at-rest.key")).unwrap(),
            format!("{}\n", STANDARD.encode([41; 32])).as_bytes()
        );
        original.validate().unwrap();
        let credential = original.credential_writer().unwrap();
        credential.validate().unwrap();
        drop(credential);
        original.seal().unwrap();
        assert!(original.validate().is_err());
        assert!(original.credential_writer().is_err());
        // Final original drop releases its held read. A fresh independent state may then
        // capture the actual changed key; the retired state never retargets to this successor.
        drop(original);
        fs::write(path.join("at-rest.key"), &next_wire).unwrap();
        let successor = NativeNodeDataState::capture(root).unwrap();
        successor.validate().unwrap();
        assert_eq!(*successor.device_key, [42; 32]);
    }
}
