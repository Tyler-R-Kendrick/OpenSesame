use super::env::scan_env;
use super::scan::{classify_ssh, scan_ssh};
use base64::Engine;
use std::fs;
use std::io::Write;

fn ssh_string(value: &[u8]) -> Vec<u8> {
    let mut out = u32::try_from(value.len())
        .expect("test SSH string fits u32")
        .to_be_bytes()
        .to_vec();
    out.extend_from_slice(value);
    out
}

fn openssh_key(encrypted: bool) -> String {
    let public = [ssh_string(b"ssh-ed25519"), ssh_string(&[7u8; 32])].concat();
    let body = [
        b"openssh-key-v1\0".as_slice(),
        &ssh_string(if encrypted {
            b"aes256-ctr".as_slice()
        } else {
            b"none".as_slice()
        }),
        &ssh_string(b"none"),
        &ssh_string(b""),
        &1u32.to_be_bytes(),
        &ssh_string(&public),
    ]
    .concat();
    let encoded = base64::engine::general_purpose::STANDARD.encode(body);
    format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{encoded}\n-----END OPENSSH PRIVATE KEY-----\n")
}

#[test]
fn reads_openssh_encryption_and_type() {
    let plain = classify_ssh(&openssh_key(false)).unwrap();
    assert_eq!(plain.0, "ssh-ed25519");
    assert!(!plain.2);
    let locked = classify_ssh(&openssh_key(true)).unwrap();
    assert!(locked.2);
}

#[test]
fn flags_dsa_as_insecure() {
    let key = "-----BEGIN DSA PRIVATE KEY-----\nAAAA\n-----END DSA PRIVATE KEY-----\n";
    let (_, _, _, supported) = classify_ssh(key).unwrap();
    assert!(!supported);
}

#[test]
fn reads_legacy_pem_encryption_headers() {
    let key = format!(
        "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,00000000000000000000000000000000\n\n{}\n-----END RSA PRIVATE KEY-----\n",
        base64::engine::general_purpose::STANDARD.encode(b"not-a-real-key")
    );
    let (_, _, encrypted, _) = classify_ssh(&key).unwrap();
    assert!(encrypted);
}

#[test]
fn strips_export_from_env_names() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("src/app");
    fs::create_dir_all(&root).unwrap();
    let path = root.join(".env");
    fs::write(&path, "export API_KEY=super-secret\n").unwrap();
    let findings = scan_env(dir.path());
    assert_eq!(findings[0].names, vec!["API_KEY"]);
}

#[test]
fn finds_sensitive_env_names_but_never_values() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("src/app");
    fs::create_dir_all(&root).unwrap();
    let path = root.join(".env.local");
    let mut file = fs::File::create(&path).unwrap();
    writeln!(file, "API_KEY=super-secret\nNODE_ENV=development").unwrap();
    let findings = scan_env(dir.path());
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].names, vec!["API_KEY"]);
    assert!(!format!("{:?}", findings[0].names).contains("super-secret"));
}

#[test]
fn ignores_names_in_ssh_ignore() {
    let dir = tempfile::tempdir().unwrap();
    let ssh = dir.path().join(".ssh");
    fs::create_dir_all(&ssh).unwrap();
    fs::write(ssh.join(".ignore"), "id_test\n").unwrap();
    fs::write(ssh.join("id_test"), openssh_key(false)).unwrap();
    assert!(scan_ssh(&ssh).is_empty());
}
