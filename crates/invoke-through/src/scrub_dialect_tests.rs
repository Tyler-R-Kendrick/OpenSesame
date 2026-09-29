//! Reflection through an encoder that spells characters its own way (ADR 0150
//! §4). An upstream that echoes the credential does so through whatever
//! encoder it uses — percent in lower-case hex, JSON with `\/` or a `\u`
//! escape per character, HTML with an entity per character — and a fixed list
//! of whole-credential forms misses every spelling it did not anticipate.
//! Each test is one such echo; none may carry the credential back.

use super::*;

/// A credential with characters every encoder treats differently.
const TOKEN: &str = "tok/with+reserved=chars&more'(1)*~";

fn scrub(input: &str) -> (String, bool) {
    let (out, hit) = Needles::new(TOKEN).scrub(Bytes::from(input.to_string()));
    (String::from_utf8(out.to_vec()).unwrap(), hit)
}

fn assert_gone(echo: &str) {
    let (out, hit) = scrub(&format!("{{\"echo\":\"{echo}\"}}"));
    assert!(hit, "not found: {echo}");
    assert_eq!(out, "{\"echo\":\"[redacted:credential]\"}", "echo {echo}");
}

fn each_char(escape: impl Fn(char) -> String) -> String {
    TOKEN.chars().map(escape).collect()
}

#[test]
fn a_percent_echo_in_lower_case_hex_is_scrubbed() {
    assert_gone("tok%2fwith%2breserved%3dchars%26more%27%281%29%2a%7e");
}

#[test]
fn an_encode_uri_component_echo_that_leaves_quote_and_parens_bare_is_scrubbed() {
    assert_gone("tok%2Fwith%2Breserved%3Dchars%26more'(1)*~");
}

#[test]
fn a_percent_echo_that_escapes_every_byte_is_scrubbed() {
    assert_gone(&each_char(|c| format!("%{:02X}", u32::from(c))));
}

#[test]
fn a_json_echo_that_escapes_the_slash_is_scrubbed() {
    assert_gone("tok\\/with+reserved=chars&more'(1)*~");
}

#[test]
fn a_json_echo_with_a_unicode_escape_per_character_is_scrubbed() {
    assert_gone(&each_char(|c| format!("\\u{:04x}", u32::from(c))));
    assert_gone(&each_char(|c| format!("\\u{:04X}", u32::from(c))));
}

#[test]
fn a_go_json_echo_that_escapes_the_ampersand_is_scrubbed() {
    assert_gone("tok/with+reserved=chars\\u0026more'(1)*~");
}

#[test]
fn an_html_echo_with_named_and_numeric_references_is_scrubbed() {
    assert_gone("tok/with+reserved=chars&amp;more&#x27;(1)*~");
    assert_gone("tok/with+reserved=chars&#38;more&#39;(1)*~");
    assert_gone(&each_char(|c| format!("&#{};", u32::from(c))));
    assert_gone(&each_char(|c| format!("&#X{:X};", u32::from(c))));
}

#[test]
fn an_echo_of_something_else_is_left_alone() {
    let input = "{\"echo\":\"tok/with+reserved=chars&more'(1)*\"}";
    let (out, hit) = scrub(input);
    assert!(!hit);
    assert_eq!(out, input);
}

#[test]
fn a_header_value_echo_in_any_dialect_is_scrubbed_as_text() {
    let needles = Needles::new(TOKEN);
    let (out, hit) =
        needles.scrub_str("x tok%2fwith%2breserved%3dchars%26more'(1)*~ y".to_string());
    assert!(hit);
    assert_eq!(out, "x [redacted:credential] y");
}
