//! The real pipeline: `tracing` events through a fmt layer whose sink is the
//! scrubbing writer (ADR 0150). A call site that logs a secret by mistake must
//! still reach the sink scrubbed, in both line formats.

#![cfg(feature = "tracing")]

use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use opensesame_redaction::{Format, ScrubMakeWriter};

#[derive(Clone, Default)]
struct Shared(Arc<Mutex<Vec<u8>>>);

impl Write for Shared {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn emit(format: Format) -> String {
    let sink = Shared::default();
    let handle = sink.clone();
    let make = ScrubMakeWriter::new(move || handle.clone(), format);
    let builder = tracing_subscriber::fmt().with_ansi(false).with_writer(make);
    let subscriber: Box<dyn tracing::Subscriber + Send + Sync> = match format {
        Format::Json => Box::new(builder.json().finish()),
        Format::Text => Box::new(builder.finish()),
    };
    tracing::subscriber::with_default(subscriber, || {
        tracing::error!(
            password = "hunter2",
            api_key = "k_live_12345",
            endpoint = "https://hooks.example/x?token=abc123&page=2",
            "delivery failed: claim https://app.example/claim#token=osc_clm_AbC.s3cr3tpart"
        );
        tracing::warn!(error = %"connect postgres://app:pw0rd@db:5432/x refused", "db");
    });
    let out = sink.0.lock().unwrap().clone();
    String::from_utf8(out).unwrap()
}

fn assert_clean(out: &str) {
    for leaked in [
        "hunter2",
        "k_live_12345",
        "abc123",
        "osc_clm_",
        "s3cr3tpart",
        "pw0rd",
    ] {
        assert!(!out.contains(leaked), "{leaked} leaked:\n{out}");
    }
    assert!(out.contains("[REDACTED]"));
    assert!(out.contains("delivery failed"), "the line stays readable");
}

#[test]
fn text_lines_reach_the_sink_scrubbed() {
    assert_clean(&emit(Format::Text));
}

#[test]
fn json_lines_reach_the_sink_scrubbed_and_stay_json() {
    let out = emit(Format::Json);
    assert_clean(&out);
    for line in out.lines() {
        serde_json::from_str::<serde_json::Value>(line).expect("every line is still JSON");
    }
    assert!(out.contains("\"page=2\"") || out.contains("page=2"));
}
