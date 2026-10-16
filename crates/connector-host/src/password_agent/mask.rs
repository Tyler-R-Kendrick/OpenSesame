//! Masking of injected secret values in child output (the inject lane's
//! answer to `op run` masking, for values `OpenSesame` resolves itself).

/// What replaces an injected secret in child output (the redaction marker).
pub const SECRET_MASK: &[u8] = b"[REDACTED]";
fn mask_variants(secrets: &[String]) -> Vec<Vec<u8>> {
    let mut variants: Vec<Vec<u8>> = Vec::new();
    for secret in secrets {
        // A provider value often carries a trailing newline the child may
        // not print; the stripped form is a prefix of the raw one, so it
        // covers both without eating the child's line breaks.
        let stripped = secret
            .strip_suffix("\r\n")
            .or_else(|| secret.strip_suffix('\n'))
            .unwrap_or(secret);
        if !stripped.is_empty() && !variants.iter().any(|v| v == stripped.as_bytes()) {
            variants.push(stripped.as_bytes().to_vec());
        }
    }
    variants.sort_by_key(|v| std::cmp::Reverse(v.len()));
    variants
}
fn find_from(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|offset| offset + from)
}
fn replace_all(haystack: &[u8], needle: &[u8], replacement: &[u8]) -> Vec<u8> {
    let mut replaced = Vec::with_capacity(haystack.len());
    let mut index = 0;
    while let Some(found) = find_from(haystack, needle, index) {
        replaced.extend_from_slice(&haystack[index..found]);
        replaced.extend_from_slice(replacement);
        index = found + needle.len();
    }
    replaced.extend_from_slice(&haystack[index..]);
    replaced
}
fn mask_with(text: &[u8], variants: &[Vec<u8>]) -> Vec<u8> {
    let mut masked = text.to_vec();
    for variant in variants {
        masked = replace_all(&masked, variant, SECRET_MASK);
    }
    masked
}
/// Replace every injected value in `text` with the redaction marker.
#[must_use]
pub fn mask_secrets(text: &[u8], secrets: &[String]) -> Vec<u8> {
    mask_with(text, &mask_variants(secrets))
}
/// The first index of `variant` in `buffered` that crosses `cut`, if any.
fn crossing_start(buffered: &[u8], variant: &[u8], cut: usize) -> Option<usize> {
    let mut from = 0;
    loop {
        let found = find_from(buffered, variant, from)?;
        if found >= cut {
            return None;
        }
        if found + variant.len() > cut {
            return Some(found);
        }
        from = found + 1;
    }
}
/// How much of `buffered` may be emitted now: everything except the held
/// tail, pulled left so no occurrence is split across the boundary.
fn emit_cut(buffered: &[u8], variants: &[Vec<u8>], hold_back: usize) -> usize {
    let mut cut = buffered.len().saturating_sub(hold_back);
    loop {
        let crossing = variants
            .iter()
            .filter_map(|variant| crossing_start(buffered, variant, cut))
            .min();
        match crossing {
            Some(start) => cut = start,
            None => return cut,
        }
    }
}
/// Streaming [`mask_secrets`] for child output: a tail is held back so a
/// value split across chunks is still caught whole, mirroring what
/// `op run` masking does for op:// values.
pub struct SecretMasker {
    variants: Vec<Vec<u8>>,
    hold_back: usize,
    buffered: Vec<u8>,
}
impl SecretMasker {
    #[must_use]
    pub fn new(secrets: &[String]) -> Self {
        let variants = mask_variants(secrets);
        let hold_back = variants
            .iter()
            .map(|variant| variant.len().saturating_sub(1))
            .max()
            .unwrap_or(0);
        Self {
            variants,
            hold_back,
            buffered: Vec::new(),
        }
    }
    /// Masked output that is safe to emit now.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        self.buffered.extend_from_slice(chunk);
        let cut = emit_cut(&self.buffered, &self.variants, self.hold_back);
        let safe: Vec<u8> = self.buffered.drain(..cut).collect();
        mask_with(&safe, &self.variants)
    }
    /// Masked remainder once the child has closed the stream.
    pub fn flush(&mut self) -> Vec<u8> {
        mask_with(&std::mem::take(&mut self.buffered), &self.variants)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn masking_replaces_values_and_their_newline_stripped_form() {
        assert_eq!(
            super::mask_secrets(
                b"a private-canary b private-canary\n",
                &["private-canary\n".into()]
            ),
            b"a [REDACTED] b [REDACTED]\n".to_vec()
        );
        assert_eq!(
            super::mask_secrets(b"plain\n", &[String::new()]),
            b"plain\n".to_vec()
        );
        let mut masker = super::SecretMasker::new(&["private-canary".into()]);
        let mut shown = masker.push(b"value is priv");
        shown.extend(masker.push(b"ate-canary ok\n"));
        shown.extend(masker.flush());
        assert_eq!(shown, b"value is [REDACTED] ok\n".to_vec());
    }
}
