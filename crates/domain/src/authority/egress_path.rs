fn percent_decode_path_segment(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let decoded = (input[i] == b'%')
            .then(|| input.get(i + 1..i + 3))
            .flatten()
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        if let Some(byte) = decoded {
            out.push(byte);
            i += 3;
        } else {
            out.push(input[i]);
            i += 1;
        }
    }
    out
}

/// Refuse paths whose raw or once-decoded form can escape a prefix on an
/// upstream that percent-decodes or treats `\` / `;` as separators.
pub(super) fn egress_path_is_well_formed(path: &str) -> bool {
    if !path.starts_with('/') {
        return false;
    }
    let ambiguous = |p: &str| {
        p.split('/').any(|seg| seg == "." || seg == "..")
            || p.chars().any(|c| c.is_control() || matches!(c, '\\' | ';'))
    };
    if ambiguous(path) {
        return false;
    }
    let decoded_bytes = percent_decode_path_segment(path.as_bytes());
    let decoded = String::from_utf8_lossy(&decoded_bytes);
    !ambiguous(&decoded)
}

#[cfg(test)]
mod tests {
    use super::super::EgressBinding;

    #[test]
    fn path_prefixes_stop_at_a_segment_boundary() {
        let e = EgressBinding {
            scheme: "https".into(),
            authorities: vec!["api.github.com".into()],
            path_prefixes: vec!["/repos/acme".into()],
            allow_redirects_cross_authority: false,
        };
        assert!(e.allows_url("https://api.github.com/repos/acme").is_ok());
        assert!(e
            .allows_url("https://api.github.com/repos/acme/catalog")
            .is_ok());
        // A bare prefix match let an attenuated grant reach a different owner.
        assert!(e
            .allows_url("https://api.github.com/repos/acme-private/secrets")
            .is_err());
    }

    #[test]
    fn encoded_path_traversals_fail_the_prefix_gate() {
        let e = EgressBinding {
            scheme: "https".into(),
            authorities: vec!["api.doppler.com".into()],
            path_prefixes: vec![
                "/v3/projects".into(),
                "/v3/configs/config/secrets/names".into(),
            ],
            allow_redirects_cross_authority: false,
        };
        assert!(e
            .allows_url("https://api.doppler.com/v3/projects/%2e%2e/%2fconfigs/config/secrets")
            .is_err());
        assert!(e
            .allows_url("https://api.doppler.com/v3/projects/foo%2f..%2fbar")
            .is_err());
        assert!(e
            .allows_url("https://api.doppler.com/v3/projects/x%5csecrets")
            .is_err());
        assert!(e
            .allows_url("https://api.doppler.com/v3/projects/legit/names")
            .is_ok());
    }
}
