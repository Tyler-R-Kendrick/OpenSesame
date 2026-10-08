use super::{DomainError, EgressBinding};

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

fn egress_path_is_well_formed(path: &str) -> bool {
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

impl EgressBinding {
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn allows_url(&self, url: &str) -> Result<(), DomainError> {
        let parsed = url::Url::parse(url).map_err(|_| DomainError::InvalidId("url".into()))?;
        if parsed.scheme() != self.scheme {
            return Err(DomainError::GrantAttenuation(format!(
                "scheme {} not allowed",
                parsed.scheme()
            )));
        }
        let host = parsed.host_str().unwrap_or_default();
        let port = parsed.port_or_known_default().unwrap_or(443);
        let authority = if parsed.port().is_some() {
            format!("{host}:{port}")
        } else {
            host.to_string()
        };
        let ok = self.authorities.iter().any(|a| {
            a == &authority
                || a == host
                || (a.contains(':') && a.as_str() == format!("{host}:{port}"))
        });
        if !ok {
            return Err(DomainError::GrantAttenuation(format!(
                "authority {authority} not in egress allowlist"
            )));
        }
        if !self.path_prefixes.is_empty() {
            let path = parsed.path();
            if !egress_path_is_well_formed(path) {
                return Err(DomainError::GrantAttenuation(
                    "path not in egress allowlist".into(),
                ));
            }
            if !self
                .path_prefixes
                .iter()
                .any(|p| path == p || path.starts_with(&format!("{}/", p.trim_end_matches('/'))))
            {
                return Err(DomainError::GrantAttenuation(
                    "path not in egress allowlist".into(),
                ));
            }
        }
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(DomainError::GrantAttenuation("userinfo URLs denied".into()));
        }
        Ok(())
    }

    /// Authenticated redirects must not cross authority unless explicitly allowed.
    ///
    /// # Errors
    ///
    /// Returns an error when validation or the underlying operation fails.
    pub fn allows_redirect(&self, from_url: &str, to_url: &str) -> Result<(), DomainError> {
        self.allows_url(from_url)?;
        if self.allow_redirects_cross_authority {
            return self.allows_url(to_url);
        }
        let from = url::Url::parse(from_url).map_err(|_| DomainError::InvalidId("url".into()))?;
        let to = url::Url::parse(to_url).map_err(|_| DomainError::InvalidId("url".into()))?;
        let from_host = from.host_str().unwrap_or_default();
        let to_host = to.host_str().unwrap_or_default();
        if from_host != to_host {
            return Err(DomainError::GrantAttenuation(
                "cross-authority redirect denied while holding credential".into(),
            ));
        }
        self.allows_url(to_url)
    }
}
