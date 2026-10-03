//! `Debug` for the types here that carry plaintext (ADR 0155).
//!
//! `#[derive(Debug)]` prints every field, and these hold an entry's line one,
//! a KDBX string field (`Password` among them) or a keyfile. Each impl prints
//! what is metadata and `[REDACTED]` for what is not. They sit apart from the
//! types because `map.rs` is at its size ledger (ADR 0093).

use std::fmt;

use crate::map::{ItemJson, KdbxEntryView, KdbxField};
use crate::ExportOptions;

impl fmt::Debug for ItemJson {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ItemJson")
            .field("secret", &"[REDACTED]")
            .field("trailer", &"[REDACTED]")
            .field("otp", &self.otp.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

impl fmt::Debug for KdbxField {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KdbxField")
            .field("key", &self.key)
            .field("value", &"[REDACTED]")
            .field("protected", &self.protected)
            .finish()
    }
}

impl fmt::Debug for KdbxEntryView {
    /// Field names print; the values are the entry's plaintext.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KdbxEntryView")
            .field("group_path", &self.group_path)
            .field("fields", &self.fields.keys().collect::<Vec<_>>())
            .field("values", &"[REDACTED]")
            .finish()
    }
}

impl fmt::Debug for ExportOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExportOptions")
            .field("cipher", &self.cipher)
            .field("argon2", &self.argon2)
            .field("keyfile", &self.keyfile.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_item_view_prints_no_plaintext() {
        let item = ItemJson {
            secret: "line-one-12345".into(),
            trailer: vec!["note-12345".into()],
            otp: Some("otpauth://totp/x?secret=otp-12345".into()),
        };
        let shown = format!("{item:?}");
        assert!(shown.contains("[REDACTED]"), "{shown}");
        for leaked in ["line-one-12345", "note-12345", "otp-12345"] {
            assert!(!shown.contains(leaked), "{leaked} in {shown}");
        }
    }

    #[test]
    fn a_kdbx_field_prints_its_name_and_not_its_value() {
        let field = KdbxField {
            key: "Password".into(),
            value: "pw-12345".into(),
            protected: true,
        };
        let shown = format!("{field:?}");
        assert!(
            shown.contains("Password") && shown.contains("[REDACTED]"),
            "{shown}"
        );
        assert!(!shown.contains("pw-12345"), "{shown}");
    }

    #[test]
    fn an_entry_view_prints_field_names_and_not_values() {
        let mut view = KdbxEntryView::default();
        view.fields.insert("Password".into(), "pw-12345".into());
        let shown = format!("{view:?}");
        assert!(
            shown.contains("Password") && shown.contains("[REDACTED]"),
            "{shown}"
        );
        assert!(!shown.contains("pw-12345"), "{shown}");
    }

    #[test]
    fn export_options_print_no_keyfile() {
        let options = ExportOptions {
            keyfile: Some(b"keyfile-12345".to_vec()),
            ..ExportOptions::default()
        };
        let shown = format!("{options:?}");
        assert!(shown.contains("[REDACTED]"), "{shown}");
        assert!(!shown.contains("keyfile-12345"), "{shown}");
        assert!(
            !shown.contains("[107"),
            "bytes of the keyfile printed: {shown}"
        );
    }
}
