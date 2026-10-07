//! The whole path a log line takes on the Host (ADR 0157): a `tracing` event,
//! scrubbed of secrets at the sink, sealed into a file that holds no plaintext,
//! and read back through the key. A secret a call site logged by mistake must
//! be in neither the file nor the reading.

use opensesame_redaction::{Format, ScrubMakeWriter};
use opensesame_sealed_log::{key_path_for, open_sink, read_tail, LogKey, LINE_PREFIX};

fn run(format: Format) {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("host.log");
    let sink = open_sink(&log, None).unwrap();
    let make = ScrubMakeWriter::new(move || sink.writer(), format);
    let builder = tracing_subscriber::fmt().with_ansi(false).with_writer(make);
    let subscriber: Box<dyn tracing::Subscriber + Send + Sync> = match format {
        Format::Json => Box::new(builder.json().finish()),
        Format::Text => Box::new(builder.finish()),
    };
    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(user = "ada", "vault unlocked");
        tracing::error!(
            password = "hunter2",
            "delivery failed: https://app.example/claim#token=osc_clm_AbC.s3cr3tpart" // gitleaks:allow — validated synthetic fixture or fixed non-secret identifier
        );
    });

    let raw = std::fs::read_to_string(&log).unwrap();
    assert!(raw.lines().all(|line| line.starts_with(LINE_PREFIX)));
    for shown in ["vault unlocked", "ada", "delivery", "hunter2", "osc_clm_"] {
        assert!(!raw.contains(shown), "{shown} rests in the clear");
    }

    let key = LogKey::load(&key_path_for(&log, None)).unwrap();
    let read = read_tail(&log, &key, 10).unwrap().join("\n");
    assert!(read.contains("vault unlocked") && read.contains("delivery failed"));
    for leaked in ["hunter2", "osc_clm_", "s3cr3tpart"] {
        assert!(!read.contains(leaked), "{leaked} was logged:\n{read}");
    }
    assert!(read.contains("[REDACTED]"));
}

#[test]
fn text_events_are_scrubbed_then_sealed() {
    run(Format::Text);
}

#[test]
fn json_events_are_scrubbed_then_sealed() {
    run(Format::Json);
}
