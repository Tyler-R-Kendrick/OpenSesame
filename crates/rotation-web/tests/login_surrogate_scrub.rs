//! Reflection: after a substitution, a response or DOM read that echoes the
//! credential reaches the model scrubbed (ADR 0150 §4, for a login). One test
//! per encoding a login round-trip can put the credential in.

#![cfg(feature = "login-surrogate")]

mod login_support;

use std::fmt::Write as _;

use base64::engine::general_purpose::{STANDARD, URL_SAFE};
use base64::Engine as _;
use login_support::{secret, SECRET};
use opensesame_rotation_web::{RedactedDom, ResponseScrub, REDACTED};
use opensesame_session_observe::LayoutEpoch;
use secrecy::SecretString;

fn scrubbed(page: &str) -> String {
    let (out, hit) = ResponseScrub::new(&secret()).scrub_text(page);
    assert!(hit, "nothing matched in {page:?}");
    assert!(out.contains(REDACTED), "{out}");
    out
}

#[test]
fn a_raw_reflection_is_scrubbed() {
    let out = scrubbed(&format!("<p>Wrong password: {SECRET}</p>"));
    assert_eq!(out, format!("<p>Wrong password: {REDACTED}</p>"));
}

#[test]
fn a_percent_encoded_reflection_is_scrubbed() {
    // RFC 3986 encoding, as a redirect's `?pw=` would carry it, in both cases.
    let upper = "pa%26ss%3Dwo%25rd%2B%20%22q%5C%20%C3%A9";
    for encoded in [upper.to_string(), upper.to_ascii_lowercase()] {
        let out = scrubbed(&format!("Location: /retry?pw={encoded}"));
        assert_eq!(out, format!("Location: /retry?pw={REDACTED}"));
    }
}

#[test]
fn a_form_encoded_reflection_is_scrubbed() {
    // The form serializer's own spelling: `+` for a space, `%XX` elsewhere.
    let encoded = "pa%26ss%3Dwo%25rd%2B+%22q%5C+%C3%A9";
    let out = scrubbed(&format!("echo: password={encoded}&x=1"));
    assert_eq!(out, format!("echo: password={REDACTED}&x=1"));
}

#[test]
fn a_json_escaped_reflection_is_scrubbed() {
    let body = serde_json::json!({ "error": "bad credentials", "echo": SECRET }).to_string();
    let out = scrubbed(&body);
    assert!(!out.contains("pa&ss"), "{out}");
    assert!(out.contains(&format!("\"echo\":\"{REDACTED}\"")), "{out}");
}

#[test]
fn an_ascii_only_json_reflection_is_scrubbed() {
    // Python's json.dumps default: non-ASCII as \u escapes, either hex case.
    for escape in ["\\u00e9", "\\u00E9"] {
        let body = format!(r#"{{"echo":"pa&ss=wo%rd+ \"q\\ {escape}"}}"#);
        let out = scrubbed(&body);
        assert_eq!(out, format!(r#"{{"echo":"{REDACTED}"}}"#));
    }
}

#[test]
fn an_html_escaped_reflection_is_scrubbed() {
    let page = r#"<input name="password" value="pa&amp;ss=wo%rd+ &quot;q\ é">"#;
    let out = scrubbed(page);
    assert_eq!(
        out,
        format!(r#"<input name="password" value="{REDACTED}">"#)
    );
}

#[test]
fn a_base64_reflection_is_scrubbed_at_every_alignment_in_both_alphabets() {
    for prefix in ["", "x", "u:", "user:"] {
        let blob = format!("{prefix}{SECRET}\n");
        for encoded in [STANDARD.encode(&blob), URL_SAFE.encode(&blob)] {
            let out = scrubbed(&format!("Authorization: Basic {encoded}"));
            let kept = out
                .trim_start_matches("Authorization: Basic ")
                .replace(REDACTED, "");
            // Only the edge groups shared with the prefix and suffix survive.
            assert!(kept.len() <= 12, "prefix {prefix:?}: kept {kept}");
        }
    }
}

#[test]
fn a_dom_read_is_scrubbed_and_keeps_its_epoch() {
    let dom =
        RedactedDom::from_stripped(format!("<div>Signed in as {SECRET}</div>"), LayoutEpoch(7));
    let (clean, hit) = ResponseScrub::new(&secret()).scrub_dom(dom);
    assert!(hit);
    assert_eq!(clean.text(), format!("<div>Signed in as {REDACTED}</div>"));
    assert_eq!(RedactedDom::epoch(&clean), LayoutEpoch(7));
}

#[test]
fn an_unreflecting_response_passes_through_untouched() {
    let scrub = ResponseScrub::new(&secret());
    let page = b"<p>Welcome back</p>";
    assert_eq!(scrub.scrub(page), (page.to_vec(), false));
    let dom = RedactedDom::from_stripped("<p>ok</p>".into(), LayoutEpoch(1));
    let (same, hit) = scrub.scrub_dom(dom.clone());
    assert!(!hit);
    assert_eq!(same, dom);
}

#[test]
fn an_empty_credential_matches_nothing() {
    let scrub = ResponseScrub::new(&SecretString::from(String::new()));
    assert_eq!(scrub.scrub(b"anything"), (b"anything".to_vec(), false));
}

/// A credential holding the characters encoders disagree about.
const MIXED: &str = "it's (a) pass!*~ wörd";

fn scrubbed_mixed(page: &str) -> String {
    let scrub = ResponseScrub::new(&SecretString::from(MIXED.to_string()));
    let (out, hit) = scrub.scrub_text(page);
    assert!(hit, "nothing matched in {page:?}");
    out
}

#[test]
fn a_reflection_encoded_by_encode_uri_component_is_scrubbed() {
    // JavaScript's encodeURIComponent leaves !'()*~ bare, unlike both the
    // RFC 3986 and the form serializer's spellings.
    let encoded = "it's%20(a)%20pass!*~%20w%C3%B6rd";
    let out = scrubbed_mixed(&format!("Location: /retry?pw={encoded}"));
    assert_eq!(out, format!("Location: /retry?pw={REDACTED}"));
}

#[test]
fn a_reflection_percent_encoded_in_mixed_hex_case_is_scrubbed() {
    let encoded = "it%27s%20%28a%29%20pass%21%2a%7e%20w%c3%B6rd";
    let out = scrubbed_mixed(&format!("next={encoded}&x=1"));
    assert_eq!(out, format!("next={REDACTED}&x=1"));
}

#[test]
fn a_django_html_escaped_reflection_is_scrubbed() {
    // Django and Python's html.escape write an apostrophe as &#x27;.
    let out = scrubbed_mixed(r#"<input value="it&#x27;s (a) pass!*~ wörd">"#);
    assert_eq!(out, format!(r#"<input value="{REDACTED}">"#));
}

#[test]
fn a_go_html_template_reflection_is_scrubbed() {
    // Go's html/template: &#34; for a quote, &#43; for a plus.
    let page = r#"<input value="pa&amp;ss=wo%rd&#43; &#34;q\ é">"#;
    let out = scrubbed(page);
    assert_eq!(out, format!(r#"<input value="{REDACTED}">"#));
}

#[test]
fn an_entity_per_character_reflection_is_scrubbed() {
    let page = MIXED.chars().fold(String::new(), |mut page, c| {
        write!(page, "&#{};", u32::from(c)).unwrap();
        page
    });
    let out = scrubbed_mixed(&format!("<p>{page}</p>"));
    assert_eq!(out, format!("<p>{REDACTED}</p>"));
}

#[test]
fn a_go_json_reflection_is_scrubbed() {
    // Go's encoding/json escapes & < > as \u0026 \u003c \u003e by default.
    let body = r#"{"echo":"pa\u0026ss=wo%rd+ \"q\\ é"}"#;
    let out = scrubbed(body);
    assert_eq!(out, format!(r#"{{"echo":"{REDACTED}"}}"#));
}

#[test]
fn a_json_reflection_with_every_character_escaped_is_scrubbed() {
    let body = MIXED.encode_utf16().fold(String::new(), |mut body, unit| {
        write!(body, "\\u{unit:04X}").unwrap();
        body
    });
    let out = scrubbed_mixed(&format!(r#"{{"echo":"{body}"}}"#));
    assert_eq!(out, format!(r#"{{"echo":"{REDACTED}"}}"#));
}
