//! Path helpers for loopback proxy allow/deny checks.

pub(crate) fn decoded_path_segment(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            out.push(bytes[index]);
            index += 1;
            continue;
        }
        let hex = bytes.get(index + 1..index + 3)?;
        let encoded = std::str::from_utf8(hex).ok()?;
        out.push(u8::from_str_radix(encoded, 16).ok()?);
        index += 3;
    }
    String::from_utf8(out).ok()
}

pub(crate) fn is_local_session_path(path: &str) -> bool {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .map(decoded_path_segment)
        .collect::<Option<Vec<_>>>()
        .as_deref()
        == Some(&["api".into(), "v1".into(), "session".into(), "local".into()])
}

