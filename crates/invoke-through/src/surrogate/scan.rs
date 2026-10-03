//! Finding surrogates in a request, and deciding whether where they were found
//! is the one place they may be. Split from the ledger so each half reads on
//! its own; nothing here is public outside [`super`].

use super::RequestView;
use super::{Refusal, RefusalCode, SurrogateSpec, SURROGATE_HEX_LEN, SURROGATE_MARKER};

/// One place a surrogate-shaped token was seen.
pub(super) struct Sighting {
    pub(super) value: String,
    /// `path`, `body`, `method`, or the lowercased header name.
    pub(super) site: String,
}

pub(super) fn check_placement(
    sightings: &[Sighting],
    spec: &SurrogateSpec,
    surrogate: &str,
    headers: &[(String, String)],
) -> Result<(), Refusal> {
    let site = spec.site.header_name();
    let misplaced = |detail: &str| {
        Err(Refusal::issued(
            RefusalCode::Misplaced,
            spec,
            Some(detail.to_string()),
        ))
    };
    if let Some(elsewhere) = sightings
        .iter()
        .find(|s| !s.site.eq_ignore_ascii_case(site))
    {
        return misplaced(&elsewhere.site);
    }
    // Exactly one header of that name, whose whole value is the surrogate in
    // the site's own syntax: a repeated header, a surrogate followed by
    // anything, or a second copy inside one value is a request shaped by
    // something other than the SDK it was issued to.
    let mut carriers = headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case(site));
    let (Some((_, value)), None) = (carriers.next(), carriers.next()) else {
        return misplaced(site);
    };
    if sightings.len() != 1 || !spec.site.is_exact(value, surrogate) {
        return misplaced(site);
    }
    Ok(())
}

/// Every surrogate-shaped token anywhere in the request: the method, header
/// names and values, the request target (raw and percent-decoded), and the body.
pub(super) fn sightings(req: &RequestView<'_>) -> Vec<Sighting> {
    let mut out: Vec<Sighting> = shaped(req.method.as_bytes())
        .into_iter()
        .map(|value| Sighting {
            value,
            site: "method".into(),
        })
        .collect();
    for (name, value) in req.headers {
        let site = name.to_ascii_lowercase();
        for found in shaped(name.as_bytes())
            .into_iter()
            .chain(shaped(value.as_bytes()))
        {
            out.push(Sighting {
                value: found,
                site: site.clone(),
            });
        }
    }
    let target = req.path_and_query.as_bytes();
    let decoded = percent_decode(target);
    let mut in_target = shaped(target);
    for found in shaped(&decoded) {
        if !in_target.contains(&found) {
            in_target.push(found);
        }
    }
    out.extend(in_target.into_iter().map(|value| Sighting {
        value,
        site: "path".into(),
    }));
    out.extend(shaped(req.body).into_iter().map(|value| Sighting {
        value,
        site: "body".into(),
    }));
    out
}

/// `osr_` followed by 32 lowercase hex characters, wherever it occurs.
fn shaped(haystack: &[u8]) -> Vec<String> {
    let marker = SURROGATE_MARKER.as_bytes();
    let len = marker.len() + SURROGATE_HEX_LEN;
    let mut found = Vec::new();
    let mut at = 0;
    while at + len <= haystack.len() {
        let candidate = &haystack[at..at + len];
        if candidate.starts_with(marker)
            && candidate[marker.len()..]
                .iter()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        {
            // ASCII by construction.
            found.push(String::from_utf8_lossy(candidate).into_owned());
            at += len;
        } else {
            at += 1;
        }
    }
    found
}

fn percent_decode(input: &[u8]) -> Vec<u8> {
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

/// The method and path this request uses must be ones the surrogate was
/// scoped to. The path is the request target up to `?`; any dot segment, raw
/// or percent-encoded, is refused outright rather than resolved, because the
/// upstream's resolution is the one that counts and it is not ours to predict.
pub(super) fn check_scope(req: &RequestView<'_>, spec: &SurrogateSpec) -> Result<(), Refusal> {
    let out_of_scope = |detail: &str| {
        Err(Refusal::issued(
            RefusalCode::OutOfScope,
            spec,
            Some(detail.to_string()),
        ))
    };
    if !spec
        .methods
        .iter()
        .any(|m| m.eq_ignore_ascii_case(req.method))
    {
        return out_of_scope(req.method);
    }
    let path = req
        .path_and_query
        .split_once('?')
        .map_or(req.path_and_query, |(path, _)| path);
    let decoded = percent_decode(path.as_bytes());
    let decoded = String::from_utf8_lossy(&decoded);
    let has_dot_segment = |p: &str| p.split('/').any(|seg| seg == "." || seg == "..");
    if !path.starts_with('/') || has_dot_segment(path) || has_dot_segment(&decoded) {
        return out_of_scope("path");
    }
    let within = spec.path_prefixes.iter().any(|prefix| {
        let prefix = prefix.trim_end_matches('/');
        path == prefix || path.starts_with(&format!("{prefix}/"))
    });
    if within {
        Ok(())
    } else {
        out_of_scope("path")
    }
}
