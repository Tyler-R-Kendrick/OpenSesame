//! A writer that scrubs whole lines on their way to a sink (ADR 0150).
//!
//! Tracing call sites are many and written by many hands; a redaction that
//! depends on each of them remembering is not a guarantee. This wraps the sink
//! itself, so nothing reaches stdout, a file or a collector unscrubbed however
//! it was logged. Lines are the unit: a secret never straddles a write because
//! nothing is emitted until its line is complete.

use std::io::{self, Write};

use serde_json::Value;

use crate::{redact_json, redact_text};

/// How a line is shaped. A JSON line is decoded, scrubbed field by field and
/// re-encoded, so escaped quotes and nested documents cannot hide a value; a
/// line that is not JSON, in either mode, is scrubbed as text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Text,
    Json,
}

/// The line decoded, scrubbed and re-encoded, or `None` when it is not JSON.
fn scrub_json(line: &str) -> Option<String> {
    let doc = serde_json::from_str::<Value>(line).ok()?;
    serde_json::to_string(&redact_json(&doc)).ok()
}

/// Buffers until a newline, then writes the scrubbed line.
pub struct ScrubWriter<W: Write> {
    inner: W,
    format: Format,
    pending: Vec<u8>,
}

impl<W: Write> ScrubWriter<W> {
    pub fn new(inner: W, format: Format) -> Self {
        Self {
            inner,
            format,
            pending: Vec::new(),
        }
    }

    fn scrub_line(&self, line: &[u8]) -> String {
        let text = String::from_utf8_lossy(line);
        let json = (self.format == Format::Json)
            .then(|| scrub_json(text.trim_end()))
            .flatten();
        json.unwrap_or_else(|| redact_text(text.trim_end_matches(['\n', '\r'])))
    }

    fn emit(&mut self, line: &[u8]) -> io::Result<()> {
        let mut out = self.scrub_line(line);
        out.push('\n');
        self.inner.write_all(out.as_bytes())
    }

    fn drain_lines(&mut self) -> io::Result<()> {
        while let Some(end) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            self.emit(&line)?;
        }
        Ok(())
    }
}

impl<W: Write> Write for ScrubWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.pending.extend_from_slice(buf);
        self.drain_lines()?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl<W: Write> Drop for ScrubWriter<W> {
    /// An unterminated last line is still a line: scrub it rather than drop it.
    fn drop(&mut self) {
        if !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            let _ = self.emit(&line);
        }
        let _ = self.inner.flush();
    }
}

/// The scrubbing sink for a `tracing_subscriber` fmt layer: every event is
/// written through a fresh [`ScrubWriter`] over `make()`.
#[cfg(feature = "tracing")]
pub struct ScrubMakeWriter<F> {
    make: F,
    format: Format,
}

#[cfg(feature = "tracing")]
impl<F> ScrubMakeWriter<F> {
    pub fn new(make: F, format: Format) -> Self {
        Self { make, format }
    }
}

#[cfg(feature = "tracing")]
impl<'a, F, W> tracing_subscriber::fmt::MakeWriter<'a> for ScrubMakeWriter<F>
where
    F: Fn() -> W + 'static,
    W: Write + 'a,
{
    type Writer = ScrubWriter<W>;

    fn make_writer(&'a self) -> Self::Writer {
        ScrubWriter::new((self.make)(), self.format)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(format: Format, writes: &[&[u8]]) -> String {
        let mut captured = Vec::new();
        {
            let mut scrubber = ScrubWriter::new(&mut captured, format);
            for chunk in writes {
                scrubber.write_all(chunk).unwrap();
            }
        }
        String::from_utf8(captured).unwrap()
    }

    #[test]
    fn a_secret_split_across_writes_is_still_scrubbed() {
        let out = run(
            Format::Text,
            &[
                b"retry Authorization: Bear",
                b"er abc.def.ghi failed\nnext line\n",
            ],
        );
        assert_eq!(out, "retry Authorization: [REDACTED] failed\nnext line\n");
    }

    #[test]
    fn json_lines_are_scrubbed_field_by_field() {
        let line = br#"{"level":"INFO","fields":{"message":"sent https://h.example/x#token=osc_clm_AbC123.secretpart","password":"hunter2","note":"{\"api_key\":\"k_1\"}"}}"#;
        let mut input = line.to_vec();
        input.push(b'\n');
        let out = run(Format::Json, &[&input]);
        for leaked in ["osc_clm_", "secretpart", "hunter2", "k_1"] {
            assert!(!out.contains(leaked), "{leaked} leaked: {out}");
        }
        let doc: Value = serde_json::from_str(out.trim()).unwrap();
        assert_eq!(doc["level"], "INFO");
        assert_eq!(doc["fields"]["password"], "[REDACTED]");
    }

    #[test]
    fn a_line_that_is_not_json_falls_back_to_text_scrubbing() {
        let out = run(Format::Json, &[b"panic: password=hunter2 in worker\n"]);
        assert_eq!(out, "panic: password=[REDACTED] in worker\n");
    }

    #[test]
    fn an_unterminated_last_line_is_scrubbed_not_dropped() {
        let out = run(Format::Text, &[b"token=abc123"]);
        assert_eq!(out, "token=[REDACTED]\n");
    }

    #[test]
    fn crlf_lines_and_blank_lines_survive() {
        let out = run(Format::Text, &[b"a\r\n\nb\n"]);
        assert_eq!(out, "a\n\nb\n");
    }

    #[test]
    fn non_utf8_bytes_do_not_abort_the_stream() {
        let out = run(Format::Text, &[b"ok \xff\xfe token=abc\n"]);
        assert!(out.contains("token=[REDACTED]"));
    }
}
