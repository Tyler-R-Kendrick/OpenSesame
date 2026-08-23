//! Pure, I/O-free mapping between KDBX entries and sealed-store [`Entry`] values.
//!
//! Everything in this module is a total function over plain data: no file
//! system, no crypto, no `keepass` types. That keeps the frozen mapping
//! contract (ADR 0052 §4.5, mirrored in `README.md` and in the pages
//! `kdbx.ts` adapter) unit- and mutation-testable on its own.
//!
//! Secret material flows through here as plain `String`s. Nothing in this
//! module logs, and error/warning values carry field *names* only — never
//! field values.

use std::collections::{BTreeMap, BTreeSet};

use opensesame_sealed_store::{find_otpauth_in_trailer, parse_otpauth, Entry, OtpUri};
use serde::Serialize;

/// KDBX string-field names the mapping treats specially.
pub const F_TITLE: &str = "Title";
/// KDBX `UserName` field.
pub const F_USERNAME: &str = "UserName";
/// KDBX `Password` field.
pub const F_PASSWORD: &str = "Password";
/// KDBX `URL` field.
pub const F_URL: &str = "URL";
/// KDBX `Notes` field.
pub const F_NOTES: &str = "Notes";
/// KDBX `otp` field (KeePassXC stores a full `otpauth://` URI here).
pub const F_OTP: &str = "otp";

/// Trailer key carrying the KDBX `UserName`.
pub const K_LOGIN: &str = "login";
/// Trailer key carrying the KDBX `URL`.
pub const K_URL: &str = "url";
/// Trailer key carrying the KDBX `Notes`.
pub const K_NOTES: &str = "notes";

/// KeePassXC "TimeOtp" attributes, consumed together into one `otpauth://` URI.
const TIMEOTP_SECRET: &str = "TimeOtp-Secret-Base32";
const TIMEOTP_LENGTH: &str = "TimeOtp-Length";
const TIMEOTP_PERIOD: &str = "TimeOtp-Period";
const TIMEOTP_ALGORITHM: &str = "TimeOtp-Algorithm";

/// Prefix marking a trailer line as the continuation of the previous value.
pub const CONTINUATION: &str = "  ";

/// Substrings that make a KDBX field protected on export (`(?i)pass|token|secret|key`).
const PROTECTED_MARKERS: [&str; 4] = ["pass", "token", "secret", "key"];

/// Non-fatal observations from a mapping. Carries names, never values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MapWarning {
    /// The KDBX `Password` spanned several lines; only the first became the secret.
    MultilinePasswordTruncated,
    /// The `otp` field was not a usable `otpauth://` URI; kept verbatim as a trailer line.
    UnusableOtpField,
    /// `TimeOtp-*` attributes did not yield a valid `otpauth://` URI; kept verbatim.
    UnusableTimeOtp,
    /// A key collided with one already emitted and was suffixed.
    DuplicateKey {
        /// The key as it would have been emitted.
        key: String,
        /// The key actually emitted.
        renamed: String,
    },
    /// The store path collided with an earlier entry in the same batch.
    PathCollision {
        /// The path the mapping asked for.
        desired: String,
        /// The path actually assigned.
        assigned: String,
    },
    /// Group nesting exceeded [`MAX_GROUP_DEPTH`]; the entry was skipped.
    DepthLimited,
}

/// Maximum group nesting walked during import. Deeper subtrees are skipped
/// rather than allowed to grow paths without bound on hostile input.
pub const MAX_GROUP_DEPTH: usize = 64;

/// A KDBX entry flattened into exactly the data the mapping consumes.
///
/// `fields` is a `BTreeMap` on purpose: `keepass` stores entry fields in a
/// `HashMap`, so iteration order there is not stable. Sorting by the raw KDBX
/// field name makes the mapped trailer deterministic.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KdbxEntryView {
    /// Group names from the root group's children down to the entry's parent.
    /// The KDBX root group itself is not part of the path.
    pub group_path: Vec<String>,
    /// Every KDBX string field, including `Title` and `Password`.
    pub fields: BTreeMap<String, String>,
}

impl KdbxEntryView {
    /// Look up a raw KDBX field.
    #[must_use]
    pub fn field(&self, name: &str) -> Option<&str> {
        self.fields.get(name).map(String::as_str)
    }
}

/// One KDBX entry mapped to a store path plus a sealed-store [`Entry`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappedEntry {
    /// The store path the entry wants, before collision resolution.
    pub desired_path: String,
    /// The mapped sealed-store entry.
    pub entry: Entry,
    /// Non-fatal observations.
    pub warnings: Vec<MapWarning>,
}

/// A mapped entry that has been assigned a final, collision-free store path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappedItem {
    /// Final store path.
    pub path: String,
    /// The mapped sealed-store entry.
    pub entry: Entry,
    /// Non-fatal observations.
    pub warnings: Vec<MapWarning>,
}

/// A KDBX string field ready to be written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KdbxField {
    /// KDBX field name.
    pub key: String,
    /// KDBX field value.
    pub value: String,
    /// Whether the field is written with `Protected="True"`.
    pub protected: bool,
}

/// A sealed-store entry unmapped back into KDBX shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnmappedEntry {
    /// Group names from the root group's children down to the entry's parent.
    pub group_path: Vec<String>,
    /// The entry title (already sanitized).
    pub title: String,
    /// Every KDBX string field, in write order.
    pub fields: Vec<KdbxField>,
}

/// The trailer split back into `key: value` pairs plus lines that are not pairs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedTrailer {
    /// `key: value` pairs, in trailer order, with continuations folded in.
    pub pairs: Vec<(String, String)>,
    /// Lines that are neither a pair nor a continuation, in trailer order.
    pub freeform: Vec<String>,
}

/// Normalize CRLF and lone CR to LF.
#[must_use]
pub fn normalize_newlines(value: &str) -> String {
    if !value.contains('\r') {
        return value.to_string();
    }
    value.replace("\r\n", "\n").replace('\r', "\n")
}

/// Sanitize one store-path segment.
///
/// 1. `/`, `\`, and control characters become `_` (applied *before* trimming,
///    so a leading tab becomes a leading `_`).
/// 2. Leading and trailing whitespace is trimmed.
/// 3. An empty segment becomes `_`.
/// 4. A segment of only `.` characters has each `.` replaced by `_`, so `.`
///    and `..` can never reach the store's path resolver.
#[must_use]
pub fn sanitize_segment(raw: &str) -> String {
    let replaced: String = raw
        .chars()
        .map(|ch| {
            if ch == '/' || ch == '\\' || ch.is_control() {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let trimmed = replaced.trim();
    if trimmed.is_empty() {
        return "_".to_string();
    }
    if trimmed.chars().all(|c| c == '.') {
        return "_".repeat(trimmed.chars().count());
    }
    trimmed.to_string()
}

/// Sanitize a KDBX field name into a trailer key.
///
/// `:` and control characters become `_`; the result is trimmed; an empty
/// result becomes `field`.
#[must_use]
pub fn sanitize_key(raw: &str) -> String {
    let replaced: String = raw
        .chars()
        .map(|ch| if ch == ':' || ch.is_control() { '_' } else { ch })
        .collect();
    let trimmed = replaced.trim();
    if trimmed.is_empty() {
        "field".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Whether a KDBX field name is written with `Protected="True"`.
///
/// Mirrors `(?i)pass|token|secret|key` without pulling in a regex engine.
#[must_use]
pub fn is_protected_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    PROTECTED_MARKERS.iter().any(|m| lower.contains(m))
}

/// Split an optional `prefix` into sanitized path segments. Empty segments are
/// dropped (so `a//b` is `a/b`), unlike group names, which become `_`.
#[must_use]
pub fn sanitize_prefix(prefix: Option<&str>) -> Vec<String> {
    prefix
        .map(|p| {
            p.split('/')
                .filter(|s| !s.trim().is_empty())
                .map(sanitize_segment)
                .collect()
        })
        .unwrap_or_default()
}

/// Render ordered `key: value` pairs as trailer text.
///
/// The first line of a value follows `key: `; every later line is prefixed
/// with [`CONTINUATION`]. The encoding is exactly reversible by
/// [`parse_trailer`], including values whose own lines start with spaces.
#[must_use]
pub fn render_trailer(pairs: &[(String, String)]) -> String {
    let mut out = String::new();
    for (key, value) in pairs {
        let value = normalize_newlines(value);
        let mut lines = value.split('\n');
        out.push_str(key);
        out.push_str(": ");
        out.push_str(lines.next().unwrap_or(""));
        out.push('\n');
        for line in lines {
            out.push_str(CONTINUATION);
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Split trailer text back into pairs plus freeform lines.
///
/// `otpauth://` lines are skipped: they are carried by [`Entry::otp`], which
/// `sealed-store` re-synthesizes on render.
#[must_use]
pub fn parse_trailer(trailer: &str) -> ParsedTrailer {
    let mut parsed = ParsedTrailer::default();
    for line in normalize_newlines(trailer).split('\n') {
        if line.is_empty() {
            continue;
        }
        if line.to_ascii_lowercase().starts_with("otpauth://") {
            continue;
        }
        if let Some(rest) = line.strip_prefix(CONTINUATION) {
            if let Some(last) = parsed.pairs.last_mut() {
                last.1.push('\n');
                last.1.push_str(rest);
                continue;
            }
            parsed.freeform.push(line.to_string());
            continue;
        }
        match split_pair(line) {
            Some(pair) => parsed.pairs.push(pair),
            None => parsed.freeform.push(line.to_string()),
        }
    }
    parsed
}

fn split_pair(line: &str) -> Option<(String, String)> {
    let idx = line.find(':')?;
    let key = line.get(..idx)?;
    if key.is_empty() || key.trim() != key {
        return None;
    }
    let rest = line.get(idx + 1..)?;
    let value = rest.strip_prefix(' ').unwrap_or(rest);
    Some((key.to_string(), value.to_string()))
}

/// Assigns collision-free store paths within one import batch.
///
/// Collisions are resolved against the batch only — never against what the
/// store already holds — so re-importing the same database lands on the same
/// paths and stays idempotent.
#[derive(Debug, Clone, Default)]
pub struct PathAllocator {
    taken: BTreeSet<String>,
}

impl PathAllocator {
    /// A fresh allocator with nothing claimed.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Claim `desired`, appending ` (2)`, ` (3)`, … until a free path is found.
    pub fn allocate(&mut self, desired: &str) -> String {
        if self.taken.insert(desired.to_string()) {
            return desired.to_string();
        }
        for n in 2u64..=1_000_000 {
            let candidate = format!("{desired} ({n})");
            if self.taken.insert(candidate.clone()) {
                return candidate;
            }
        }
        // Unreachable for any real database; still never loops forever.
        let candidate = format!("{desired} ({})", self.taken.len());
        self.taken.insert(candidate.clone());
        candidate
    }
}

fn push_pair(
    pairs: &mut Vec<(String, String)>,
    used: &mut BTreeSet<String>,
    key: &str,
    value: &str,
    warnings: &mut Vec<MapWarning>,
) {
    let value = normalize_newlines(value);
    if value.is_empty() {
        return;
    }
    let key = dedup(key, used, warnings);
    pairs.push((key, value));
}

fn dedup(key: &str, used: &mut BTreeSet<String>, warnings: &mut Vec<MapWarning>) -> String {
    if used.insert(key.to_string()) {
        return key.to_string();
    }
    for n in 2u64..=1_000_000 {
        let candidate = format!("{key}_{n}");
        if used.insert(candidate.clone()) {
            warnings.push(MapWarning::DuplicateKey {
                key: key.to_string(),
                renamed: candidate.clone(),
            });
            return candidate;
        }
    }
    let candidate = format!("{key}_{}", used.len());
    used.insert(candidate.clone());
    candidate
}

/// Percent-encode a string for use in an `otpauth://` label or query value.
/// Only RFC 3986 unreserved characters pass through.
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '.' | '_' | '~') {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn map_otp(view: &KdbxEntryView, title: &str) -> (Option<OtpUri>, BTreeSet<String>, Vec<MapWarning>) {
    let mut consumed = BTreeSet::new();
    let mut warnings = Vec::new();

    if let Some(raw) = view.field(F_OTP).map(str::trim).filter(|v| !v.is_empty()) {
        if raw.to_ascii_lowercase().starts_with("otpauth://") {
            match parse_otpauth(raw) {
                Ok(otp) => {
                    consumed.insert(F_OTP.to_string());
                    return (Some(otp), consumed, warnings);
                }
                Err(_) => warnings.push(MapWarning::UnusableOtpField),
            }
        } else {
            warnings.push(MapWarning::UnusableOtpField);
        }
        return (None, consumed, warnings);
    }

    let Some(secret) = view
        .field(TIMEOTP_SECRET)
        .map(str::trim)
        .filter(|v| !v.is_empty())
    else {
        return (None, consumed, warnings);
    };

    let digits: u32 = view
        .field(TIMEOTP_LENGTH)
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(6);
    let period: u64 = view
        .field(TIMEOTP_PERIOD)
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(30);
    let algorithm = view
        .field(TIMEOTP_ALGORITHM)
        .map(|v| {
            v.trim()
                .to_ascii_uppercase()
                .replace("HMAC-", "")
                .replace('-', "")
        })
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "SHA1".to_string());

    let label = if title.trim().is_empty() {
        "entry".to_string()
    } else {
        percent_encode(title.trim())
    };
    let uri = format!(
        "otpauth://totp/{label}?secret={}&digits={digits}&period={period}&algorithm={}",
        percent_encode(secret),
        percent_encode(&algorithm),
    );
    match parse_otpauth(&uri) {
        Ok(otp) => {
            for key in [
                TIMEOTP_SECRET,
                TIMEOTP_LENGTH,
                TIMEOTP_PERIOD,
                TIMEOTP_ALGORITHM,
            ] {
                consumed.insert(key.to_string());
            }
            (Some(otp), consumed, warnings)
        }
        Err(_) => {
            warnings.push(MapWarning::UnusableTimeOtp);
            (None, consumed, warnings)
        }
    }
}

/// Map one KDBX entry to a store path and a sealed-store [`Entry`].
///
/// See `README.md` for the normative statement of this contract.
#[must_use]
pub fn map_entry(view: &KdbxEntryView) -> MappedEntry {
    let mut warnings = Vec::new();

    let title = view.field(F_TITLE).unwrap_or("");
    let password = normalize_newlines(view.field(F_PASSWORD).unwrap_or(""));
    if password.lines().count() > 1 {
        warnings.push(MapWarning::MultilinePasswordTruncated);
    }
    let secret = password.lines().next().unwrap_or("").to_string();

    let (otp, otp_consumed, otp_warnings) = map_otp(view, title);
    warnings.extend(otp_warnings);

    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut used: BTreeSet<String> = BTreeSet::new();
    push_pair(
        &mut pairs,
        &mut used,
        K_LOGIN,
        view.field(F_USERNAME).unwrap_or(""),
        &mut warnings,
    );
    push_pair(
        &mut pairs,
        &mut used,
        K_URL,
        view.field(F_URL).unwrap_or(""),
        &mut warnings,
    );
    push_pair(
        &mut pairs,
        &mut used,
        K_NOTES,
        view.field(F_NOTES).unwrap_or(""),
        &mut warnings,
    );
    for (raw_key, value) in &view.fields {
        if matches!(
            raw_key.as_str(),
            F_TITLE | F_PASSWORD | F_USERNAME | F_URL | F_NOTES
        ) || otp_consumed.contains(raw_key)
        {
            continue;
        }
        let key = sanitize_key(raw_key);
        push_pair(&mut pairs, &mut used, &key, value, &mut warnings);
    }

    let mut trailer = render_trailer(&pairs);
    // `Entry::render` concatenates an empty secret straight onto the trailer,
    // so an entry with no `Password` but with fields would come back with its
    // first trailer line parsed as the secret. Keep line one explicitly empty
    // so the store round-trips a password-less entry unchanged.
    if secret.is_empty() && (!trailer.is_empty() || otp.is_some()) {
        trailer.insert(0, '\n');
    }

    let entry = Entry {
        secret,
        trailer,
        otp: None,
    }
    .with_otp(otp);

    let mut segments: Vec<String> = view.group_path.iter().map(|g| sanitize_segment(g)).collect();
    segments.push(sanitize_segment(title));

    MappedEntry {
        desired_path: segments.join("/"),
        entry,
        warnings,
    }
}

/// Map a sealed-store [`Entry`] at `path` back into KDBX shape.
///
/// The inverse of [`map_entry`] for everything [`map_entry`] produces. Trailer
/// lines that are not `key: value` pairs (only possible in hand-written store
/// entries) are appended to `Notes` rather than dropped.
#[must_use]
pub fn unmap_entry(path: &str, entry: &Entry) -> UnmappedEntry {
    let mut warnings = Vec::new();
    let mut segments: Vec<String> = path
        .split('/')
        .filter(|s| !s.trim().is_empty())
        .map(sanitize_segment)
        .collect();
    let title = segments.pop().unwrap_or_else(|| "_".to_string());

    let parsed = parse_trailer(&entry.trailer);
    let mut fields: Vec<KdbxField> = Vec::new();
    let mut used: BTreeSet<String> = BTreeSet::new();

    push_field(&mut fields, &mut used, F_TITLE, &title, false, &mut warnings);
    if !entry.secret.is_empty() {
        push_field(
            &mut fields,
            &mut used,
            F_PASSWORD,
            &entry.secret,
            true,
            &mut warnings,
        );
    }
    if let Some(otp) = &entry.otp {
        // `otp` does not match the protected-key regex, but a TOTP seed is
        // secret material: always write it protected.
        push_field(&mut fields, &mut used, F_OTP, &otp.uri, true, &mut warnings);
    }

    for (key, value) in &parsed.pairs {
        let name = match key.as_str() {
            K_LOGIN => F_USERNAME.to_string(),
            K_URL => F_URL.to_string(),
            K_NOTES => F_NOTES.to_string(),
            other => other.to_string(),
        };
        let protected = is_protected_key(&name);
        push_field(&mut fields, &mut used, &name, value, protected, &mut warnings);
    }

    if !parsed.freeform.is_empty() {
        let extra = parsed.freeform.join("\n");
        match fields.iter_mut().find(|f| f.key == F_NOTES) {
            Some(notes) => {
                notes.value.push('\n');
                notes.value.push_str(&extra);
            }
            None => fields.push(KdbxField {
                key: F_NOTES.to_string(),
                value: extra,
                protected: false,
            }),
        }
    }

    UnmappedEntry {
        group_path: segments,
        title,
        fields,
    }
}

fn push_field(
    fields: &mut Vec<KdbxField>,
    used: &mut BTreeSet<String>,
    key: &str,
    value: &str,
    protected: bool,
    warnings: &mut Vec<MapWarning>,
) {
    let key = dedup(key, used, warnings);
    fields.push(KdbxField {
        key,
        value: value.to_string(),
        protected,
    });
}

/// The canonical JSON view of one mapped item, used by the conformance fixture.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ItemJson {
    /// Line one of the entry.
    pub secret: String,
    /// Trailer lines, excluding blank lines and the `otpauth://` line.
    pub trailer: Vec<String>,
    /// The `otpauth://` URI, if any.
    pub otp: Option<String>,
}

/// Render an [`Entry`] into its canonical JSON view.
///
/// Computed straight from the entry's fields, deliberately **not** by
/// re-rendering and re-parsing it. `sealed_store::Entry`'s render/parse pair is
/// not a fixed point: the blank line separating the secret from the trailer
/// moves in and out of `trailer`, and for an empty secret a re-render promotes
/// the first trailer line into line one. Two entries that mean the same thing
/// must compare equal regardless of which side of a store write they came
/// from, so the canonical form drops blank lines and lifts the `otpauth://`
/// line out of the trailer.
#[must_use]
pub fn item_json(entry: &Entry) -> ItemJson {
    let trailer = entry
        .trailer
        .lines()
        .filter(|l| !l.is_empty())
        .filter(|l| !l.to_ascii_lowercase().starts_with("otpauth://"))
        .map(str::to_string)
        .collect();
    let otp = entry
        .otp
        .as_ref()
        .map(|o| o.uri.clone())
        .or_else(|| find_otpauth_in_trailer(&entry.trailer).map(|o| o.uri));
    ItemJson {
        secret: entry.secret.clone(),
        trailer,
        otp,
    }
}

/// Version tag written into `fixtures/kdbx/roundtrip.expected.json`.
pub const CONFORMANCE_FORMAT: &str = "opensesame-kdbx-conformance/1";

/// The conformance document for a mapped item set: `{ format, items }` with
/// `items` keyed by store path in sorted order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConformanceDoc {
    /// Format tag, always [`CONFORMANCE_FORMAT`].
    pub format: &'static str,
    /// Mapped items, keyed by store path.
    pub items: BTreeMap<String, ItemJson>,
}

/// Build the conformance document for a mapped item set.
#[must_use]
pub fn conformance_doc(items: &[MappedItem]) -> ConformanceDoc {
    ConformanceDoc {
        format: CONFORMANCE_FORMAT,
        items: items
            .iter()
            .map(|i| (i.path.clone(), item_json(&i.entry)))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RFC_SEED: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    /// Trailer lines with blank separators removed — the shape the store
    /// actually holds, independent of the empty-secret line-one convention.
    fn tlines(m: &MappedEntry) -> Vec<String> {
        m.entry
            .trailer
            .lines()
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect()
    }

    fn view(group_path: &[&str], fields: &[(&str, &str)]) -> KdbxEntryView {
        KdbxEntryView {
            group_path: group_path.iter().map(|s| (*s).to_string()).collect(),
            fields: fields
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
        }
    }

    #[test]
    fn password_becomes_line_one() {
        let m = map_entry(&view(&[], &[(F_TITLE, "T"), (F_PASSWORD, "hunter2")]));
        assert_eq!(m.entry.secret, "hunter2");
        assert_eq!(m.desired_path, "T");
        assert!(m.warnings.is_empty());
    }

    #[test]
    fn missing_password_maps_to_empty_secret() {
        let m = map_entry(&view(&[], &[(F_TITLE, "T")]));
        assert_eq!(m.entry.secret, "");
    }

    #[test]
    fn multiline_password_keeps_first_line_and_warns() {
        let m = map_entry(&view(&[], &[(F_TITLE, "T"), (F_PASSWORD, "one\ntwo")]));
        assert_eq!(m.entry.secret, "one");
        assert!(m.warnings.contains(&MapWarning::MultilinePasswordTruncated));
    }

    #[test]
    fn known_fields_map_to_reserved_trailer_keys() {
        let m = map_entry(&view(
            &[],
            &[
                (F_TITLE, "T"),
                (F_USERNAME, "alice"),
                (F_URL, "https://example.com"),
                (F_NOTES, "hello"),
            ],
        ));
        assert_eq!(
            tlines(&m),
            ["login: alice", "url: https://example.com", "notes: hello"]
        );
    }

    #[test]
    fn empty_values_emit_no_trailer_line() {
        let m = map_entry(&view(&[], &[(F_TITLE, "T"), (F_USERNAME, ""), (F_URL, "u")]));
        assert_eq!(tlines(&m), ["url: u"]);
    }

    #[test]
    fn multiline_notes_use_continuation_lines() {
        let m = map_entry(&view(&[], &[(F_TITLE, "T"), (F_NOTES, "one\ntwo\n\nfour")]));
        assert_eq!(tlines(&m), ["notes: one", "  two", "  ", "  four"]);
        let back = parse_trailer(&m.entry.trailer);
        assert_eq!(
            back.pairs,
            vec![("notes".to_string(), "one\ntwo\n\nfour".to_string())]
        );
    }

    #[test]
    fn crlf_is_normalized() {
        let m = map_entry(&view(&[], &[(F_TITLE, "T"), (F_NOTES, "one\r\ntwo")]));
        assert_eq!(tlines(&m), ["notes: one", "  two"]);
    }

    #[test]
    fn custom_fields_are_preserved_sorted_by_raw_name() {
        let m = map_entry(&view(
            &[],
            &[(F_TITLE, "T"), ("Zebra", "z"), ("Alpha", "a")],
        ));
        assert_eq!(tlines(&m), ["Alpha: a", "Zebra: z"]);
    }

    #[test]
    fn custom_key_colliding_with_reserved_key_is_suffixed() {
        let m = map_entry(&view(
            &[],
            &[(F_TITLE, "T"), (F_USERNAME, "alice"), ("login", "bob")],
        ));
        assert_eq!(tlines(&m), ["login: alice", "login_2: bob"]);
        assert!(m.warnings.iter().any(|w| matches!(
            w,
            MapWarning::DuplicateKey { key, renamed } if key == "login" && renamed == "login_2"
        )));
    }

    #[test]
    fn field_names_with_colons_and_controls_are_sanitized() {
        assert_eq!(sanitize_key("a:b"), "a_b");
        assert_eq!(sanitize_key("a\tb"), "a_b");
        assert_eq!(sanitize_key("   "), "field");
        assert_eq!(sanitize_key("  spaced  "), "spaced");
    }

    #[test]
    fn otpauth_field_becomes_structured_otp() {
        let uri = format!("otpauth://totp/Demo?secret={RFC_SEED}");
        let m = map_entry(&view(&[], &[(F_TITLE, "T"), (F_OTP, &uri)]));
        assert_eq!(m.entry.otp.as_ref().map(|o| o.uri.as_str()), Some(&*uri));
        assert!(!m.entry.trailer.contains("otp: "));
    }

    #[test]
    fn unusable_otp_field_is_preserved_verbatim() {
        let m = map_entry(&view(&[], &[(F_TITLE, "T"), (F_OTP, "key=ABC&size=6")]));
        assert!(m.entry.otp.is_none());
        assert_eq!(tlines(&m), ["otp: key=ABC&size=6"]);
        assert!(m.warnings.contains(&MapWarning::UnusableOtpField));
    }

    #[test]
    fn otpauth_field_that_fails_validation_is_preserved_verbatim() {
        let m = map_entry(&view(
            &[],
            &[(F_TITLE, "T"), (F_OTP, "otpauth://totp/Demo?issuer=x")],
        ));
        assert!(m.entry.otp.is_none());
        assert!(m.entry.trailer.contains("otp: otpauth://totp/Demo?issuer=x"));
        assert!(m.warnings.contains(&MapWarning::UnusableOtpField));
    }

    #[test]
    fn timeotp_attributes_become_otpauth_uri() {
        let m = map_entry(&view(
            &[],
            &[
                (F_TITLE, "Deploy Token"),
                (TIMEOTP_SECRET, RFC_SEED),
                (TIMEOTP_LENGTH, "8"),
                (TIMEOTP_PERIOD, "60"),
                (TIMEOTP_ALGORITHM, "HMAC-SHA-256"),
            ],
        ));
        let otp = m.entry.otp.expect("otp");
        assert_eq!(
            otp.uri,
            format!("otpauth://totp/Deploy%20Token?secret={RFC_SEED}&digits=8&period=60&algorithm=SHA256")
        );
        assert_eq!(otp.digits, 8);
        assert_eq!(otp.period, 60);
        // consumed, so none of them leak into the trailer
        assert!(!m.entry.trailer.contains("TimeOtp"));
    }

    #[test]
    fn timeotp_defaults_apply_when_attributes_are_absent_or_junk() {
        let m = map_entry(&view(
            &[],
            &[
                (F_TITLE, "T"),
                (TIMEOTP_SECRET, RFC_SEED),
                (TIMEOTP_LENGTH, "not-a-number"),
            ],
        ));
        let otp = m.entry.otp.expect("otp");
        assert_eq!(otp.digits, 6);
        assert_eq!(otp.period, 30);
    }

    #[test]
    fn unusable_timeotp_secret_is_preserved_verbatim() {
        let m = map_entry(&view(
            &[],
            &[(F_TITLE, "T"), (TIMEOTP_SECRET, "!!!not-base32!!!")],
        ));
        assert!(m.entry.otp.is_none());
        assert!(m.entry.trailer.contains("TimeOtp-Secret-Base32: !!!not-base32!!!"));
        assert!(m.warnings.contains(&MapWarning::UnusableTimeOtp));
    }

    #[test]
    fn unknown_timeotp_algorithm_is_rejected_not_defaulted() {
        let m = map_entry(&view(
            &[],
            &[
                (F_TITLE, "T"),
                (TIMEOTP_SECRET, RFC_SEED),
                (TIMEOTP_ALGORITHM, "HMAC-MD5"),
            ],
        ));
        assert!(m.entry.otp.is_none());
        assert!(m.warnings.contains(&MapWarning::UnusableTimeOtp));
    }

    #[test]
    fn group_path_and_title_build_the_store_path() {
        let m = map_entry(&view(&["Personal", "Email"], &[(F_TITLE, "GitHub")]));
        assert_eq!(m.desired_path, "Personal/Email/GitHub");
    }

    #[test]
    fn path_segments_are_sanitized() {
        assert_eq!(sanitize_segment("a/b"), "a_b");
        assert_eq!(sanitize_segment("a\\b"), "a_b");
        assert_eq!(sanitize_segment("a\tb"), "a_b");
        assert_eq!(sanitize_segment("a\u{0}b"), "a_b");
        assert_eq!(sanitize_segment("  padded  "), "padded");
        assert_eq!(sanitize_segment(""), "_");
        assert_eq!(sanitize_segment("   "), "_");
        assert_eq!(sanitize_segment("."), "_");
        assert_eq!(sanitize_segment(".."), "__");
        assert_eq!(sanitize_segment("..."), "___");
        assert_eq!(sanitize_segment("\tlead"), "_lead");
    }

    #[test]
    fn sanitized_segments_survive_the_store_path_resolver() {
        for hostile in ["..", ".", "", "a/b", "\u{0}"] {
            let name = format!("Group/{}", sanitize_segment(hostile));
            opensesame_sealed_store::logical_to_relative(&name)
                .unwrap_or_else(|e| panic!("{hostile:?} -> {name:?}: {e}"));
        }
    }

    #[test]
    fn allocator_suffixes_collisions_in_order() {
        let mut alloc = PathAllocator::new();
        assert_eq!(alloc.allocate("a/b"), "a/b");
        assert_eq!(alloc.allocate("a/b"), "a/b (2)");
        assert_eq!(alloc.allocate("a/b"), "a/b (3)");
        assert_eq!(alloc.allocate("a/c"), "a/c");
        assert_eq!(alloc.allocate("a/b (2)"), "a/b (2) (2)");
    }

    #[test]
    fn protected_key_selection_matches_the_regex() {
        for yes in [
            "Password", "password", "API Key", "Recovery Token", "client_secret", "PassPhrase",
            "keyfile",
        ] {
            assert!(is_protected_key(yes), "{yes} should be protected");
        }
        for no in ["Title", "UserName", "URL", "Notes", "login", "url", "notes", "Comment"] {
            assert!(!is_protected_key(no), "{no} should not be protected");
        }
    }

    #[test]
    fn unmap_inverts_map_for_the_full_field_set() {
        let uri = format!("otpauth://totp/Demo?secret={RFC_SEED}");
        let m = map_entry(&view(
            &["Personal", "Email"],
            &[
                (F_TITLE, "GitHub"),
                (F_USERNAME, "alice"),
                (F_PASSWORD, "hunter2"),
                (F_URL, "https://github.com"),
                (F_NOTES, "line one\nline two"),
                ("Recovery Code", "abcd"),
                (F_OTP, &uri),
            ],
        ));
        let un = unmap_entry(&m.desired_path, &m.entry);
        assert_eq!(un.group_path, vec!["Personal", "Email"]);
        assert_eq!(un.title, "GitHub");
        let by_key: BTreeMap<&str, &KdbxField> =
            un.fields.iter().map(|f| (f.key.as_str(), f)).collect();
        assert_eq!(by_key["Title"].value, "GitHub");
        assert_eq!(by_key["Password"].value, "hunter2");
        assert!(by_key["Password"].protected);
        assert_eq!(by_key["UserName"].value, "alice");
        assert!(!by_key["UserName"].protected);
        assert_eq!(by_key["URL"].value, "https://github.com");
        assert_eq!(by_key["Notes"].value, "line one\nline two");
        assert_eq!(by_key["Recovery Code"].value, "abcd");
        assert_eq!(by_key["otp"].value, uri);
        assert!(by_key["otp"].protected);
    }

    #[test]
    fn unmap_round_trips_back_through_map() {
        let uri = format!("otpauth://totp/Demo?secret={RFC_SEED}");
        let original = map_entry(&view(
            &["A", "B"],
            &[
                (F_TITLE, "C"),
                (F_USERNAME, "alice"),
                (F_PASSWORD, "hunter2"),
                (F_URL, "https://x"),
                (F_NOTES, "one\ntwo\n\nfour"),
                ("Custom Field", "value: with colon"),
                (F_OTP, &uri),
            ],
        ));
        let un = unmap_entry(&original.desired_path, &original.entry);
        let re = map_entry(&KdbxEntryView {
            group_path: un.group_path.clone(),
            fields: un
                .fields
                .iter()
                .map(|f| (f.key.clone(), f.value.clone()))
                .collect(),
        });
        assert_eq!(re.desired_path, original.desired_path);
        assert_eq!(re.entry.render(), original.entry.render());
    }

    #[test]
    fn unmap_folds_freeform_lines_into_notes() {
        let entry = Entry {
            secret: "pw".into(),
            trailer: "notes: kept\nnot a pair line\n".into(),
            otp: None,
        };
        let un = unmap_entry("A/B", &entry);
        let notes = un.fields.iter().find(|f| f.key == F_NOTES).expect("notes");
        assert_eq!(notes.value, "kept\nnot a pair line");
    }

    #[test]
    fn unmap_creates_notes_for_freeform_when_absent() {
        let entry = Entry {
            secret: "pw".into(),
            trailer: "orphan line\n".into(),
            otp: None,
        };
        let un = unmap_entry("A", &entry);
        let notes = un.fields.iter().find(|f| f.key == F_NOTES).expect("notes");
        assert_eq!(notes.value, "orphan line");
    }

    #[test]
    fn unmap_renames_trailer_keys_that_collide_with_kdbx_reserved_names() {
        let entry = Entry {
            secret: "pw".into(),
            trailer: "Title: shadow\nPassword: shadow\n".into(),
            otp: None,
        };
        let un = unmap_entry("A", &entry);
        let keys: Vec<&str> = un.fields.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(keys, vec!["Title", "Password", "Title_2", "Password_2"]);
    }

    #[test]
    fn unmap_of_an_empty_secret_writes_no_password_field() {
        let entry = Entry {
            secret: String::new(),
            trailer: "notes: n\n".into(),
            otp: None,
        };
        let un = unmap_entry("A", &entry);
        assert!(un.fields.iter().all(|f| f.key != F_PASSWORD));
    }

    #[test]
    fn parse_trailer_skips_blank_and_otpauth_lines() {
        let parsed = parse_trailer("\nlogin: a\notpauth://totp/x?secret=AA\nurl: b\n");
        assert_eq!(
            parsed.pairs,
            vec![
                ("login".to_string(), "a".to_string()),
                ("url".to_string(), "b".to_string())
            ]
        );
        assert!(parsed.freeform.is_empty());
    }

    #[test]
    fn parse_trailer_treats_orphan_continuation_as_freeform() {
        let parsed = parse_trailer("  orphan\n");
        assert!(parsed.pairs.is_empty());
        assert_eq!(parsed.freeform, vec!["  orphan".to_string()]);
    }

    #[test]
    fn parse_trailer_rejects_pairs_with_leading_space_in_key() {
        let parsed = parse_trailer(" k: v\n");
        assert!(parsed.pairs.is_empty());
        assert_eq!(parsed.freeform, vec![" k: v".to_string()]);
    }

    #[test]
    fn render_and_parse_trailer_round_trip_values_starting_with_spaces() {
        let pairs = vec![("k".to_string(), "  indented\n    more".to_string())];
        let rendered = render_trailer(&pairs);
        assert_eq!(rendered, "k:   indented\n      more\n");
        assert_eq!(parse_trailer(&rendered).pairs, pairs);
    }

    #[test]
    fn sanitize_prefix_drops_empty_segments() {
        assert_eq!(sanitize_prefix(None), Vec::<String>::new());
        assert_eq!(sanitize_prefix(Some("//a//b//")), vec!["a", "b"]);
        assert_eq!(sanitize_prefix(Some("a/../b")), vec!["a", "__", "b"]);
    }

    #[test]
    fn password_less_entry_round_trips_through_the_store_rendering() {
        let m = map_entry(&view(&[], &[(F_TITLE, "T"), (F_USERNAME, "alice")]));
        assert_eq!(m.entry.secret, "");
        assert_eq!(tlines(&m), ["login: alice"]);
        let parsed = Entry::parse(&m.entry.render());
        assert_eq!(parsed.secret, "");
        assert!(parsed.trailer.contains("login: alice"));
    }

    #[test]
    fn password_less_entry_with_only_an_otp_round_trips() {
        let uri = format!("otpauth://totp/Demo?secret={RFC_SEED}");
        let m = map_entry(&view(&[], &[(F_TITLE, "T"), (F_OTP, &uri)]));
        let parsed = Entry::parse(&m.entry.render());
        assert_eq!(parsed.secret, "");
        assert_eq!(parsed.otp.map(|o| o.uri), Some(uri));
    }

    #[test]
    fn password_less_entry_with_no_fields_stays_empty() {
        let m = map_entry(&view(&[], &[(F_TITLE, "T")]));
        assert_eq!(m.entry.trailer, "");
        assert_eq!(Entry::parse(&m.entry.render()).secret, "");
    }

    #[test]
    fn item_json_excludes_blank_and_otpauth_lines() {
        let uri = format!("otpauth://totp/Demo?secret={RFC_SEED}");
        let m = map_entry(&view(
            &[],
            &[(F_TITLE, "T"), (F_USERNAME, "alice"), (F_OTP, &uri)],
        ));
        let json = item_json(&m.entry);
        assert_eq!(json.secret, "");
        assert_eq!(json.trailer, vec!["login: alice".to_string()]);
        assert_eq!(json.otp.as_deref(), Some(&*uri));
    }

    #[test]
    fn percent_encoding_covers_reserved_characters() {
        assert_eq!(percent_encode("Deploy Token"), "Deploy%20Token");
        assert_eq!(percent_encode("a/b?c=d&e"), "a%2Fb%3Fc%3Dd%26e");
        assert_eq!(percent_encode("safe-._~09AZaz"), "safe-._~09AZaz");
    }
}
