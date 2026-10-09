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

pub(crate) fn has_dot_segment(path: &str) -> bool {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .any(|segment| matches!(decoded_path_segment(segment).as_deref(), Some("." | "..")))
}

pub(crate) fn is_local_session_path(path: &str) -> bool {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .map(decoded_path_segment)
        .collect::<Option<Vec<_>>>()
        .as_deref()
        == Some(&["api".into(), "v1".into(), "session".into(), "local".into()])
}

#[cfg(test)]
mod tests {
    use super::has_dot_segment;

    #[test]
    fn encoded_dot_segments_are_traversal() {
        assert!(has_dot_segment("/x/%2e%2e/y"));
        assert!(has_dot_segment("/x/%2E%2E/y"));
        assert!(has_dot_segment("/x/%2e./y"));
        assert!(has_dot_segment("/x/.%2e/y"));
        assert!(has_dot_segment("/%2e"));
    }

    #[test]
    fn ordinary_segments_are_not_traversal() {
        assert!(!has_dot_segment("/api/v1/session/local"));
        assert!(!has_dot_segment("/x/a%2Eb/y"));
        assert!(!has_dot_segment("/x/%2eg/y"));
        assert!(!has_dot_segment("/x/..y"));
    }
}
