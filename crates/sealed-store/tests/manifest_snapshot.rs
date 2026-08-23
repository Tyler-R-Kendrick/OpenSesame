//! Snapshot of the attachment manifest's serialized shape.
//!
//! The manifest is the root of trust for an attachment and is stored as sealed
//! JSON. Renaming or dropping a field is a silent breaking change: old
//! manifests on disk deserialize into an error, and the attachment they
//! describe becomes unrecoverable even though every chunk is still present.
//!
//! Volatile values are redacted, so this pins the *shape* — field names,
//! nesting, types — and not the contents of any particular attachment.

use opensesame_sealed_store::{AttachmentManifest, ChunkRef};

fn sample() -> AttachmentManifest {
    AttachmentManifest {
        format: 1,
        attachment_id: "07070707070707070707070707070707".into(),
        filename: "w2.pdf".into(),
        mime: "application/pdf".into(),
        total_bytes: 1_400_000,
        chunk_bytes: 1_048_576,
        chunk_count: 2,
        chunks: vec![
            ChunkRef {
                digest: "aa".repeat(32),
                ct_bytes: 1_048_624,
                pt_bytes: 1_048_576,
            },
            ChunkRef {
                digest: "bb".repeat(32),
                ct_bytes: 351_472,
                pt_bytes: 351_424,
            },
        ],
        content_digest: "blake3:cc".into(),
        created_at_unix_ms: 1_700_000_000_000,
    }
}

#[test]
fn manifest_shape_is_stable() {
    insta::assert_json_snapshot!(sample(), {
        ".attachment_id" => "[id]",
        ".created_at_unix_ms" => "[ts]",
        ".content_digest" => "[digest]",
        ".chunks[].digest" => "[digest]",
    });
}

#[test]
fn a_manifest_written_by_an_earlier_version_still_parses() {
    // Captured from the serializer once. If a field is renamed or removed,
    // this stops parsing — which is exactly what would happen to a manifest
    // sitting in someone's store.
    let stored = r#"{
      "format": 1,
      "attachment_id": "07070707070707070707070707070707",
      "filename": "w2.pdf",
      "mime": "application/pdf",
      "total_bytes": 1400000,
      "chunk_bytes": 1048576,
      "chunk_count": 2,
      "chunks": [
        {"digest": "aa", "ct_bytes": 1048624, "pt_bytes": 1048576},
        {"digest": "bb", "ct_bytes": 351472, "pt_bytes": 351424}
      ],
      "content_digest": "blake3:cc",
      "created_at_unix_ms": 1700000000000
    }"#;
    let parsed: AttachmentManifest =
        serde_json::from_str(stored).expect("an already-stored manifest must still deserialize");
    assert_eq!(parsed.chunk_count, 2);
    assert_eq!(parsed.total_bytes, 1_400_000);
    assert_eq!(parsed.chunks.len(), 2);
}
