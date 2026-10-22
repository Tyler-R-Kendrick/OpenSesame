//! Local metadata scan for SSH keys and plaintext `.env` files.

use base64::Engine;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_FILE: u64 = 1024 * 1024;
const SSH_DEPTH: usize = 3;
#[derive(Clone, Copy)]
pub enum Finding {
    Insecure,
    Unencrypted,
    ImportCandidate,
    Unsupported,
}

impl Finding {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Insecure => "insecure_key_type",
            Self::Unencrypted => "unencrypted",
            Self::ImportCandidate => "import_candidate",
            Self::Unsupported => "unsupported",
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Insecure => "insecure key type",
            Self::Unencrypted => "unencrypted",
            Self::ImportCandidate => "import into OpenSesame",
            Self::Unsupported => "unsupported",
        }
    }
}

pub struct SshFinding {
    pub path: String,
    pub key_type: String,
    pub bits: Option<u32>,
    pub encrypted: bool,
    pub finding: Finding,
}

pub(crate) fn home_default() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub(crate) fn is_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_file() && !m.file_type().is_symlink())
        .unwrap_or(false)
}

pub(crate) fn is_dir(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_dir() && !m.file_type().is_symlink())
        .unwrap_or(false)
}

pub(crate) fn small_file(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE {
        return None;
    }
    String::from_utf8(fs::read(path).ok()?).ok()
}

pub(crate) fn walk(root: &Path, depth: usize, max_depth: usize, out: &mut Vec<PathBuf>) {
    if depth > max_depth || !is_dir(root) {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        if is_dir(&path) {
            if depth < max_depth {
                walk(&path, depth + 1, max_depth, out);
            }
        } else if is_file(&path) {
            out.push(path);
        }
    }
}

fn wildcard(pattern: &str, name: &str) -> bool {
    let (p, n) = (pattern.as_bytes(), name.as_bytes());
    let (mut star, mut mark) = (None, 0);
    let (mut pi, mut ni) = (0, 0);
    while ni < n.len() {
        if pi < p.len() && (p[pi] == b'?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == b'*' {
            star = Some(pi);
            pi += 1;
            mark = ni;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ni = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

fn ignored(names: &[String], path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    names.iter().any(|pattern| wildcard(pattern, name))
}

fn read_ignore(ssh_root: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(ssh_root.join(".ignore")) else {
        return Vec::new();
    };
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect()
}

fn pem(text: &str) -> Option<(&str, String, Vec<String>)> {
    let start = text.find("-----BEGIN ")?;
    let rest = &text[start + 11..];
    let end = rest.find("-----")?;
    let label = &rest[..end];
    let body_start = start + 11 + end + 5;
    let end_marker = format!("-----END {label}-----");
    let body_end = text[body_start..].find(&end_marker)? + body_start;
    let block = &text[body_start..body_end];
    let mut headers = Vec::new();
    let mut joined = String::new();
    let mut in_body = false;
    for line in block.lines() {
        if !in_body {
            if line.trim().is_empty() {
                in_body = true;
                continue;
            }
            if line.contains(':') {
                headers.push(line.trim().to_owned());
                continue;
            }
            in_body = true;
        }
        joined.push_str(line.trim());
    }
    Some((label, joined, headers))
}

fn read_string(bytes: &[u8], offset: usize) -> Option<(Vec<u8>, usize)> {
    if offset + 4 > bytes.len() {
        return None;
    }
    let len = u32::from_be_bytes(bytes[offset..offset + 4].try_into().ok()?) as usize;
    let start = offset + 4;
    let end = start.checked_add(len)?;
    if end > bytes.len() {
        return None;
    }
    Some((bytes[start..end].to_vec(), end))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<(u32, usize)> {
    if offset + 4 > bytes.len() {
        return None;
    }
    Some((
        u32::from_be_bytes(bytes[offset..offset + 4].try_into().ok()?),
        offset + 4,
    ))
}

fn mpint_bits(value: &[u8]) -> u32 {
    let mut i = 0;
    while i < value.len() && value[i] == 0 {
        i += 1;
    }
    if i == value.len() {
        return 0;
    }
    let lead = value[i].leading_zeros();
    (u32::try_from(value.len() - i).unwrap_or(u32::MAX) * 8).saturating_sub(lead)
}

fn openssh_finding(text: &str) -> Option<(String, Option<u32>, bool)> {
    let (_, body, _) = pem(text)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body)
        .ok()?;
    let magic = b"openssh-key-v1\0";
    if !bytes.starts_with(magic) {
        return None;
    }
    let mut at = magic.len();
    let (cipher, next) = read_string(&bytes, at)?;
    at = next;
    let (_kdf, next) = read_string(&bytes, at)?;
    at = next;
    let (_options, next) = read_string(&bytes, at)?;
    at = next;
    let (_nkeys, next) = read_u32(&bytes, at)?;
    at = next;
    let (public, _) = read_string(&bytes, at)?;
    let (kind, next) = read_string(&public, 0)?;
    let kind = String::from_utf8(kind).ok()?;
    let mut bits = None;
    if kind == "ssh-rsa" {
        let (_e, next) = read_string(&public, next)?;
        let (n, _) = read_string(&public, next)?;
        bits = Some(mpint_bits(&n));
    }
    Some((kind, bits, cipher.as_slice() != b"none"))
}

fn der_len(bytes: &[u8], at: usize) -> Option<(usize, usize)> {
    let first = *bytes.get(at)? as usize;
    if first < 0x80 {
        return Some((first, at + 1));
    }
    let count = first & 0x7f;
    if count == 0 || count > 4 || at + 1 + count > bytes.len() {
        return None;
    }
    let mut len = 0usize;
    for byte in &bytes[at + 1..at + 1 + count] {
        len = len.checked_mul(256)?.checked_add(*byte as usize)?;
    }
    Some((len, at + 1 + count))
}

fn pkcs1_bits(body: &str) -> Option<u32> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body)
        .ok()?;
    // SEQUENCE { INTEGER version, INTEGER modulus, ... }
    if *bytes.first()? != 0x30 {
        return None;
    }
    let (_, mut at) = der_len(&bytes, 1)?;
    for index in 0..2 {
        if *bytes.get(at)? != 0x02 {
            return None;
        }
        let (len, start) = der_len(&bytes, at + 1)?;
        let value = bytes.get(start..start + len)?;
        if index == 1 {
            return Some(mpint_bits(value));
        }
        at = start + len;
    }
    None
}

pub(crate) fn classify_ssh(text: &str) -> Option<(String, Option<u32>, bool, bool)> {
    if let Some((kind, bits, encrypted)) = openssh_finding(text) {
        let supported = kind == "ssh-ed25519" || kind == "ssh-rsa";
        let insecure =
            kind == "ssh-rsa" && bits.is_some_and(|bits| bits < 2048) || kind == "ssh-dss";
        return Some((kind, bits, encrypted, supported && !insecure));
    }
    let (label, body, headers) = pem(text)?;
    let encrypted = headers
        .iter()
        .any(|h| h.starts_with("Proc-Type:") && h.contains("ENCRYPTED"))
        || label == "ENCRYPTED PRIVATE KEY";
    match label {
        "RSA PRIVATE KEY" => {
            let bits = pkcs1_bits(&body);
            let insecure = bits.is_some_and(|bits| bits < 2048);
            Some(("ssh-rsa".into(), bits, encrypted, !insecure))
        }
        "DSA PRIVATE KEY" => Some(("ssh-dss".into(), None, encrypted, false)),
        "EC PRIVATE KEY" => Some(("ecdsa".into(), None, encrypted, false)),
        "OPENSSH PRIVATE KEY" => None,
        "PRIVATE KEY" | "ENCRYPTED PRIVATE KEY" => Some(("pkcs8".into(), None, encrypted, true)),
        _ => None,
    }
}

pub(crate) fn scan_ssh(root: &Path) -> Vec<SshFinding> {
    let ignore = read_ignore(root);
    let mut files = Vec::new();
    walk(root, 0, SSH_DEPTH, &mut files);
    let mut findings = Vec::new();
    for path in files {
        if ignored(&ignore, &path) {
            continue;
        }
        let Some(text) = small_file(&path) else {
            continue;
        };
        if !text.contains("PRIVATE KEY-----") {
            continue;
        }
        let Some((key_type, bits, encrypted, supported)) = classify_ssh(&text) else {
            continue;
        };
        let finding =
            if key_type == "ssh-dss" || (key_type == "ssh-rsa" && bits.is_some_and(|b| b < 2048)) {
                Finding::Insecure
            } else if !supported {
                Finding::Unsupported
            } else if !encrypted {
                Finding::Unencrypted
            } else {
                Finding::ImportCandidate
            };
        findings.push(SshFinding {
            path: path.display().to_string(),
            key_type,
            bits,
            encrypted,
            finding,
        });
    }
    findings.sort_by(|a, b| a.path.cmp(&b.path));
    findings
}
