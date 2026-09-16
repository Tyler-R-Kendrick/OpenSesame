//! What the bytes actually are, decided before anything tries to run them.
//!
//! The rule this module exists to enforce: **an unsupported guest refuses,
//! it does not fall back**. A sandbox that cannot contain a payload has
//! exactly one correct answer, and "run it natively instead" is not it. An
//! ELF, a Mach-O, a PE, or a `#!` script reaching this crate is a caller
//! bug, and the refusal names the format so the caller can say why rather
//! than retrying against a subprocess.

/// A guest payload's on-the-wire shape.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuestFormat {
    /// A WebAssembly **core module** — the only thing this crate runs.
    WasmModule,
    /// A WebAssembly component. Refused here: the component world belongs to
    /// `opensesame-connector-host`, which binds a different import surface.
    WasmComponent,
    /// A WebAssembly binary whose layer/version this runtime does not know.
    WasmUnknownLayer,
    /// ELF — Linux/BSD native executable or shared object.
    Elf,
    /// Mach-O, in any of its four magics (32/64-bit, either endianness).
    MachO,
    /// A fat/universal Mach-O archive.
    MachOUniversal,
    /// PE/COFF — a Windows `.exe`/`.dll` (an `MZ` DOS stub).
    Pe,
    /// A `#!` interpreter script.
    Shebang,
    /// A Java class file or JAR — `CAFEBABE` / `PK\x03\x04`.
    JvmArtifact,
    /// Anything else, including an empty payload.
    Unknown,
}

const WASM_MAGIC: [u8; 4] = [0x00, 0x61, 0x73, 0x6d];
const CORE_VERSION: [u8; 4] = [0x01, 0x00, 0x00, 0x00];
const COMPONENT_VERSION: [u8; 4] = [0x0d, 0x00, 0x01, 0x00];

impl GuestFormat {
    /// Classify a payload by its leading bytes.
    ///
    /// Sniffing is deliberate: a caller may hand over bytes from a registry,
    /// a manifest, or a user, and the extension they came with is not
    /// evidence. Nothing here parses further than the magic.
    #[must_use]
    pub fn detect(bytes: &[u8]) -> Self {
        if bytes.starts_with(&WASM_MAGIC) {
            return Self::detect_wasm_layer(bytes);
        }
        if bytes.starts_with(b"\x7fELF") {
            return Self::Elf;
        }
        if bytes.starts_with(b"#!") {
            return Self::Shebang;
        }
        if bytes.starts_with(b"MZ") {
            return Self::Pe;
        }
        if bytes.starts_with(b"PK\x03\x04") {
            return Self::JvmArtifact;
        }
        Self::detect_by_word(bytes)
    }

    fn detect_wasm_layer(bytes: &[u8]) -> Self {
        match bytes.get(4..8) {
            Some(v) if v == CORE_VERSION => Self::WasmModule,
            Some(v) if v == COMPONENT_VERSION => Self::WasmComponent,
            _ => Self::WasmUnknownLayer,
        }
    }

    fn detect_by_word(bytes: &[u8]) -> Self {
        let Some(head) = bytes.get(0..4) else {
            return Self::Unknown;
        };
        match head {
            // Mach-O thin: 32/64-bit, big/little endian.
            [0xfe, 0xed, 0xfa, 0xce | 0xcf] | [0xce | 0xcf, 0xfa, 0xed, 0xfe] => Self::MachO,
            // Fat archives, both the 32-bit and 64-bit table forms.
            [0xca, 0xfe, 0xba, 0xbe | 0xbf] | [0xbe | 0xbf, 0xba, 0xfe, 0xca] => {
                Self::MachOUniversal
            }
            _ => Self::Unknown,
        }
    }

    /// Whether this runtime can contain the payload.
    #[must_use]
    pub const fn is_runnable(self) -> bool {
        matches!(self, Self::WasmModule)
    }

    /// Whether the payload is a native artifact for some host CPU.
    ///
    /// Kept separate from [`Self::is_runnable`] so a caller can log the
    /// sharper fact: not merely "unsupported" but "this would have executed
    /// outside every boundary we have".
    #[must_use]
    pub const fn is_native(self) -> bool {
        matches!(
            self,
            Self::Elf | Self::MachO | Self::MachOUniversal | Self::Pe | Self::Shebang
        )
    }

    /// A short, stable name for receipts and refusal messages.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WasmModule => "wasm_module",
            Self::WasmComponent => "wasm_component",
            Self::WasmUnknownLayer => "wasm_unknown_layer",
            Self::Elf => "elf",
            Self::MachO => "mach_o",
            Self::MachOUniversal => "mach_o_universal",
            Self::Pe => "pe",
            Self::Shebang => "shebang_script",
            Self::JvmArtifact => "jvm_artifact",
            Self::Unknown => "unknown",
        }
    }

    /// Why the payload is refused, or `None` when it is runnable.
    #[must_use]
    pub const fn refusal(self) -> Option<&'static str> {
        match self {
            Self::WasmModule => None,
            Self::WasmComponent => Some(
                "wasm component: the component world is the connector host's; \
                 this sandbox runs core modules",
            ),
            Self::WasmUnknownLayer => Some("wasm binary with an unrecognized layer version"),
            Self::Elf | Self::MachO | Self::MachOUniversal | Self::Pe => Some(
                "native executable: this host has no sandbox that contains it, \
                 so it is refused rather than run unsandboxed",
            ),
            Self::Shebang => Some(
                "interpreter script: running it would mean spawning an \
                 interpreter outside every boundary this crate enforces",
            ),
            Self::JvmArtifact => Some("jvm artifact: no contained runtime exists for it here"),
            Self::Unknown => Some("unrecognized payload"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::GuestFormat;

    #[test]
    fn a_core_module_is_the_only_runnable_shape() {
        assert_eq!(
            GuestFormat::detect(b"\x00asm\x01\x00\x00\x00"),
            GuestFormat::WasmModule
        );
        assert!(GuestFormat::WasmModule.is_runnable());
        assert!(GuestFormat::WasmModule.refusal().is_none());

        // Every other variant refuses, including the wasm ones.
        for other in [
            GuestFormat::WasmComponent,
            GuestFormat::WasmUnknownLayer,
            GuestFormat::Elf,
            GuestFormat::MachO,
            GuestFormat::MachOUniversal,
            GuestFormat::Pe,
            GuestFormat::Shebang,
            GuestFormat::JvmArtifact,
            GuestFormat::Unknown,
        ] {
            assert!(!other.is_runnable(), "{other:?}");
            assert!(other.refusal().is_some(), "{other:?}");
        }
    }

    #[test]
    fn native_binaries_are_recognized_as_native_not_merely_unsupported() {
        let cases: [(&[u8], GuestFormat); 6] = [
            (b"\x7fELF\x02\x01\x01\x00", GuestFormat::Elf),
            (&[0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0], GuestFormat::MachO),
            (&[0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0], GuestFormat::MachO),
            (
                &[0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2],
                GuestFormat::MachOUniversal,
            ),
            (b"MZ\x90\x00\x03\x00\x00\x00", GuestFormat::Pe),
            (b"#!/usr/bin/env python3\n", GuestFormat::Shebang),
        ];
        for (bytes, expected) in cases {
            let got = GuestFormat::detect(bytes);
            assert_eq!(got, expected, "{expected:?}");
            assert!(got.is_native(), "{expected:?} must read as native");
        }
    }

    #[test]
    fn a_component_is_distinguished_from_a_module_by_its_layer() {
        assert_eq!(
            GuestFormat::detect(b"\x00asm\x0d\x00\x01\x00"),
            GuestFormat::WasmComponent
        );
        assert_eq!(
            GuestFormat::detect(b"\x00asm\x07\x00\x00\x00"),
            GuestFormat::WasmUnknownLayer
        );
        // A truncated preamble is not a module either.
        assert_eq!(
            GuestFormat::detect(b"\x00asm"),
            GuestFormat::WasmUnknownLayer
        );
    }

    #[test]
    fn nothing_and_noise_are_unknown_and_refused() {
        assert_eq!(GuestFormat::detect(b""), GuestFormat::Unknown);
        assert_eq!(GuestFormat::detect(b"\x00\x01"), GuestFormat::Unknown);
        assert!(GuestFormat::detect(b"hello, world").refusal().is_some());
    }
}
