//! Text about a failed delivery that outlives the attempt (ADR 0157).
//!
//! A sink's endpoint is the hook's secret-bearing address: it can carry a token
//! in its query, and a transport error names it. That text is persisted on the
//! delivery and on the hook and is logged, so it is scrubbed here, before it is
//! cut, and never carries the URL at all when it comes from the transport.

/// A failure's detail as it may be stored: scrubbed, then bounded.
pub fn persistable(detail: &str, max_chars: usize) -> String {
    opensesame_redaction::redact_text(detail)
        .chars()
        .take(max_chars)
        .collect()
}

/// A transport error's text without the URL it names.
pub fn transport(error: reqwest::Error) -> String {
    format!("request failed: {}", error.without_url())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_detail_is_scrubbed_before_it_is_cut() {
        let detail = format!("{}https://h.example/x?token=abc123", "e".repeat(10));
        let stored = persistable(&detail, 32);
        assert!(!stored.contains("abc123"), "{stored}");
        assert!(stored.chars().count() <= 32);
    }

    #[tokio::test]
    async fn a_transport_error_does_not_carry_the_endpoint() {
        let error = reqwest::Client::new()
            .get("http://127.0.0.1:9/hook?token=abc123")
            .send()
            .await
            .unwrap_err();
        let text = transport(error);
        assert!(
            !text.contains("abc123") && !text.contains("127.0.0.1:9/hook"),
            "{text}"
        );
    }

    #[tokio::test]
    async fn a_path_token_in_the_endpoint_never_reaches_the_failure_text() {
        // Slack-style hook URLs carry the token in the path, which the
        // query-shaped scrub rules cannot see: the text must not name the URL.
        let error = reqwest::Client::new()
            .post("http://127.0.0.1:9/services/T0001/B0002/xoxb-pathtoken9876/v1/intent")
            .send()
            .await
            .unwrap_err();
        let text = persistable(&transport(error), 200);
        for leaked in [
            "pathtoken9876",
            "xoxb",
            "T0001",
            "/services/",
            "127.0.0.1:9",
        ] {
            assert!(!text.contains(leaked), "{leaked} leaked: {text}");
        }
    }
}
