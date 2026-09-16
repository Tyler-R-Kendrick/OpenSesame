//! Unsupported payloads refuse; they do not fall back to running natively.
//!
//! This is the property that is easiest to regress by being helpful. A
//! future "well, we could just exec it" is a sandbox escape written as a
//! convenience, so the refusal is asserted against the real spawn path
//! rather than against the sniffing function alone.

#![cfg(all(feature = "wasm-runtime", feature = "fixtures"))]

mod support;

use opensesame_sandbox::{GuestFormat, SandboxError};

/// Payloads that must never execute, with the format each should be
/// recognized as.
fn refusable() -> Vec<(&'static str, Vec<u8>, GuestFormat)> {
    vec![
        ("linux elf", elf_like(), GuestFormat::Elf),
        (
            "macos mach-o",
            vec![0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01],
            GuestFormat::MachO,
        ),
        (
            "macos universal binary",
            vec![0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02],
            GuestFormat::MachOUniversal,
        ),
        (
            "windows pe",
            b"MZ\x90\x00\x03\x00\x00\x00\x04\x00".to_vec(),
            GuestFormat::Pe,
        ),
        (
            "shell script",
            b"#!/bin/sh\nrm -rf /\n".to_vec(),
            GuestFormat::Shebang,
        ),
        (
            "python script",
            b"#!/usr/bin/env python3\nimport os\n".to_vec(),
            GuestFormat::Shebang,
        ),
        (
            "jar",
            b"PK\x03\x04\x14\x00\x08\x00".to_vec(),
            GuestFormat::JvmArtifact,
        ),
        ("empty", Vec::new(), GuestFormat::Unknown),
        (
            "noise",
            b"not a program at all".to_vec(),
            GuestFormat::Unknown,
        ),
    ]
}

fn elf_like() -> Vec<u8> {
    let mut bytes = b"\x7fELF\x02\x01\x01\x00".to_vec();
    bytes.extend_from_slice(&[0u8; 8]);
    bytes.extend_from_slice(&[0x02, 0x00, 0x3e, 0x00]);
    bytes
}

#[test]
fn a_native_binary_is_refused_by_the_spawn_path_itself() {
    let sandbox = support::permissive_sandbox();
    for (label, bytes, expected) in refusable() {
        assert_eq!(
            GuestFormat::detect(&bytes),
            expected,
            "{label} should be detected as {expected:?}"
        );
        match sandbox.spawn(&bytes) {
            Err(SandboxError::UnsupportedPayload { format, reason }) => {
                assert_eq!(format, expected.as_str(), "{label}");
                assert!(!reason.is_empty(), "{label} must say why");
            }
            other => panic!("{label} must be refused, got {other:?}"),
        }
    }
}

#[test]
fn wat_text_is_not_accepted_even_though_the_engine_could_parse_it() {
    // Wasmtime is built with `wat` support, so `Module::new` would happily
    // assemble this. The sandbox refuses it before compilation: what a
    // caller hands over is either a wasm binary or it is not a guest.
    let text = b"(module (func (export \"run\") (result i32) (i32.const 0)))".to_vec();
    assert!(matches!(
        support::permissive_sandbox().spawn(&text),
        Err(SandboxError::UnsupportedPayload { .. })
    ));
}

#[test]
fn a_wasm_component_is_refused_because_this_is_not_its_runtime() {
    // Components belong to `opensesame-connector-host`, which binds a
    // different import world. Running one here with this linker would be a
    // category error, so the preamble is checked rather than assumed.
    let component_preamble = b"\x00asm\x0d\x00\x01\x00".to_vec();
    match support::permissive_sandbox().spawn(&component_preamble) {
        Err(SandboxError::UnsupportedPayload { format, reason }) => {
            assert_eq!(format, "wasm_component");
            assert!(reason.contains("connector host"), "{reason}");
        }
        other => panic!("a component must be refused, got {other:?}"),
    }
}

#[test]
fn a_truncated_or_corrupt_module_fails_to_compile_rather_than_running() {
    // Correct preamble, garbage body: this one reaches the compiler, and
    // the compiler is the thing that refuses it.
    let mut corrupt = b"\x00asm\x01\x00\x00\x00".to_vec();
    corrupt.extend_from_slice(&[0xff; 32]);
    assert!(matches!(
        support::permissive_sandbox().spawn(&corrupt),
        Err(SandboxError::Runtime(_))
    ));
}
