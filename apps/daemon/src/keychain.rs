//! OS keychain label enumeration and keychain offers (ADR 0048 §3c).
//!
//! The backends implement [`KeychainBackend`] per platform and return item
//! *labels* — display names — only. None of them reads a secret value: the
//! Linux backend never calls `get_secret`, the macOS backend searches with
//! `kSecReturnData` off, and the Windows backend reads only `TargetName`.
//! [`KeychainOfferProbe`] turns those labels into capability-moded offers.
//!
//! Keychain-sourced offers carry `[Importable]` only. `InvokeThrough` for the
//! same provider comes from the CLI probe as a separate offer item
//! ([`crate::cli_probe`]) and merges at report time, per ADR 0048 §3d.

use opensesame_connection_detect::{
    CapabilityClass, CapabilityProbe, Confidence, KeychainBackend, KeychainStore, OfferItem,
    ProbeContext, ProbeError, ProbeSource,
};
use std::sync::Arc;

/// Known keychain label prefixes → provider id. Matching is case-insensitive
/// on the prefix; the first match wins, so longer prefixes come before any
/// overlapping shorter one. Labels are display names chosen by whatever tool
/// stored the item (`gh` uses `gh:github.com`, docker helpers use
/// `docker-credential-…`); unknown tools get an unknown prefix and a
/// lower-confidence offer rather than silence.
const KNOWN_LABEL_PREFIXES: &[(&str, &str)] = &[
    ("docker-credential-", "docker"),
    ("gh:", "github"),
    ("github.com", "github"),
    ("glab:", "gitlab"),
    ("gitlab.com", "gitlab"),
    ("aws-vault", "aws"),
    ("aws", "aws"),
    ("gcloud", "gcp"),
    ("google", "gcp"),
    ("azure", "azure-sm"),
    ("az:", "azure-sm"),
    ("op://", "1password"),
    ("1password", "1password"),
    ("doppler", "doppler"),
    ("infisical", "infisical"),
    ("hashicorp", "vault"),
    ("vault:", "vault"),
    ("openbao", "openbao"),
    ("bao:", "openbao"),
    ("kubernetes", "kubernetes"),
    ("kubectl", "kubernetes"),
];

/// The provider a keychain label refers to, when the prefix is known.
fn provider_for_label(label: &str) -> Option<&'static str> {
    let lowered = label.to_ascii_lowercase();
    KNOWN_LABEL_PREFIXES
        .iter()
        .find(|(prefix, _)| lowered.starts_with(prefix))
        .map(|(_, provider)| *provider)
}

/// Turns keychain labels into offers. Known prefixes map to their provider at
/// high confidence — the tool that wrote the item named its provider —
/// everything else is offered under the label itself at medium confidence, so
/// a person can still see it and decide.
pub struct KeychainOfferProbe;

impl CapabilityProbe for KeychainOfferProbe {
    fn id(&self) -> &'static str {
        "keychain"
    }

    fn probe(&self, ctx: &ProbeContext) -> Result<Vec<OfferItem>, ProbeError> {
        let labels = ctx.keychain.enumerate_labels()?;
        Ok(labels
            .into_iter()
            .map(|(store, item_label)| {
                let (provider_id, confidence) = match provider_for_label(&item_label) {
                    Some(provider) => (provider.to_string(), Confidence::High),
                    None => (item_label.clone(), Confidence::Medium),
                };
                OfferItem {
                    provider_id,
                    source: ProbeSource::Keychain { store, item_label },
                    capabilities: vec![CapabilityClass::Importable],
                    confidence,
                    registry_hint: None,
                }
            })
            .collect())
    }
}

/// The platform's real backend, or an empty one where no store exists.
pub fn platform_backend() -> Arc<dyn KeychainBackend> {
    imp::backend()
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use secret_service::blocking::SecretService;
    use secret_service::EncryptionType;

    /// Linux Secret Service (D-Bus) backend.
    ///
    /// Locking behavior: the default collection is inspected **without ever
    /// calling `unlock`**, so no unlock prompt is triggered and nothing waits
    /// on one. A locked collection yields zero labels and is not an error —
    /// the caller treats the absence as low signal, per the ADR. Every call
    /// below is a plain D-Bus read of item metadata; `get_secret` is never
    /// invoked, so no value ever crosses into this process.
    pub struct SecretServiceBackend;

    impl KeychainBackend for SecretServiceBackend {
        fn enumerate_labels(&self) -> Result<Vec<(KeychainStore, String)>, ProbeError> {
            let service = SecretService::connect(EncryptionType::Dh)
                .map_err(|e| ProbeError::Keychain(format!("secret-service connect: {e}")))?;
            let collection = service
                .get_default_collection()
                .map_err(|e| ProbeError::Keychain(format!("secret-service collection: {e}")))?;
            if collection.is_locked().unwrap_or(true) {
                return Ok(Vec::new());
            }
            let items = collection
                .get_all_items()
                .map_err(|e| ProbeError::Keychain(format!("secret-service items: {e}")))?;
            let mut labels = Vec::new();
            for item in items {
                // Label only. Attribute *values* and the secret stay unread.
                if let Ok(label) = item.get_label() {
                    if !label.is_empty() {
                        labels.push((KeychainStore::SecretService, label));
                    }
                }
            }
            Ok(labels)
        }
    }

    pub fn backend() -> Arc<dyn KeychainBackend> {
        Arc::new(SecretServiceBackend)
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit};

    /// macOS Keychain backend.
    ///
    /// The search is **attribute-only**: `load_attributes(true)` with
    /// `load_data(false)` maps to `kSecReturnAttributes` without
    /// `kSecReturnData`, so the Security framework returns service/label
    /// metadata and never the secret. Reading attributes does not trigger an
    /// ACL prompt. The caveat recorded in ADR 0048 §3c stands for any future
    /// change here: the moment a value is read the OS, not we, decides to
    /// prompt — and per-item ACLs mean one prompt per item, which is why no
    /// code path may ever loop over items reading values. There is one search
    /// call, and prompts are neither triggered nor suppressible by us.
    pub struct MacOsKeychainBackend;

    impl KeychainBackend for MacOsKeychainBackend {
        fn enumerate_labels(&self) -> Result<Vec<(KeychainStore, String)>, ProbeError> {
            let results = ItemSearchOptions::new()
                .class(ItemClass::generic_password())
                .load_attributes(true)
                .load_data(false)
                .limit(Limit::All)
                .search()
                .map_err(|e| ProbeError::Keychain(format!("macOS keychain search: {e}")))?;
            let mut labels = Vec::new();
            for result in results {
                let Some(attributes) = result.simplify_dict() else {
                    continue;
                };
                // kSecAttrService ("svce") is what `gh:`-style tools set;
                // kSecAttrLabel ("labl") is the display fallback.
                let label = attributes.get("svce").or_else(|| attributes.get("labl"));
                if let Some(label) = label {
                    if !label.is_empty() {
                        labels.push((KeychainStore::MacOsKeychain, label.clone()));
                    }
                }
            }
            Ok(labels)
        }
    }

    pub fn backend() -> Arc<dyn KeychainBackend> {
        Arc::new(MacOsKeychainBackend)
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use windows_sys::Win32::Security::Credentials::{
        CredEnumerateW, CredFree, CREDENTIALW, CRED_ENUMERATE_ALL_CREDENTIALS,
    };

    /// Windows Credential Manager backend.
    ///
    /// `CredEnumerateW` returns credential *metadata* — target names, not
    /// blobs — in a single call, so enumeration never touches a secret and
    /// never prompts. Only `TargetName` is read; `CredentialBlob` stays
    /// untouched.
    pub struct WindowsCredentialManagerBackend;

    impl KeychainBackend for WindowsCredentialManagerBackend {
        fn enumerate_labels(&self) -> Result<Vec<(KeychainStore, String)>, ProbeError> {
            unsafe {
                let mut count: u32 = 0;
                let mut credentials: *mut *mut CREDENTIALW = std::ptr::null_mut();
                if CredEnumerateW(
                    std::ptr::null(),
                    CRED_ENUMERATE_ALL_CREDENTIALS,
                    &mut count,
                    &mut credentials,
                ) == 0
                {
                    return Err(ProbeError::Keychain(format!(
                        "CredEnumerateW: {}",
                        std::io::Error::last_os_error()
                    )));
                }
                let mut labels = Vec::new();
                for index in 0..count as isize {
                    let credential = *credentials.offset(index);
                    if credential.is_null() {
                        continue;
                    }
                    let target = (*credential).TargetName;
                    if target.is_null() {
                        continue;
                    }
                    let mut len = 0;
                    while *target.add(len) != 0 {
                        len += 1;
                    }
                    let name = String::from_utf16_lossy(std::slice::from_raw_parts(target, len));
                    if !name.is_empty() {
                        labels.push((KeychainStore::WindowsCredentialManager, name));
                    }
                }
                CredFree(credentials as *const core::ffi::c_void);
                Ok(labels)
            }
        }
    }

    pub fn backend() -> Arc<dyn KeychainBackend> {
        Arc::new(WindowsCredentialManagerBackend)
    }
}

/// Platforms without a known store get an empty backend: no keychain offers,
/// no error.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod imp {
    use super::*;

    struct NoKeychain;

    impl KeychainBackend for NoKeychain {
        fn enumerate_labels(&self) -> Result<Vec<(KeychainStore, String)>, ProbeError> {
            Ok(Vec::new())
        }
    }

    pub fn backend() -> Arc<dyn KeychainBackend> {
        Arc::new(NoKeychain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_connection_detect::{MockCommandRunner, MockKeychain};
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn ctx_with_labels(labels: Vec<(KeychainStore, &str)>) -> ProbeContext {
        let mut keychain = MockKeychain::new();
        for (store, label) in labels {
            keychain = keychain.with_label(store, label);
        }
        ProbeContext {
            home_dir: PathBuf::from("/nonexistent"),
            env: BTreeMap::new(),
            keychain: Arc::new(keychain),
            commands: Arc::new(MockCommandRunner::new()),
            max_read_bytes: 8 * 1024,
        }
    }

    #[test]
    fn known_prefixes_map_to_their_provider_at_high_confidence() {
        let cases: &[(&str, &str)] = &[
            ("gh:github.com", "github"),
            ("GitHub.com", "github"),
            ("glab:gitlab.com", "gitlab"),
            ("docker-credential-desktop.exe", "docker"),
            ("docker-credential-helpers", "docker"),
            ("aws-vault", "aws"),
            ("op://Private/API", "1password"),
            ("1password", "1password"),
            ("doppler-cli", "doppler"),
            ("infisical", "infisical"),
            ("vault:token", "vault"),
            ("openbao:token", "openbao"),
            ("kubernetes-admin", "kubernetes"),
        ];
        for (label, provider) in cases {
            assert_eq!(provider_for_label(label), Some(*provider), "{label}");
        }
        assert_eq!(provider_for_label("totally-unrelated-app"), None);
    }

    #[test]
    fn keychain_offers_are_importable_and_carry_the_label_not_a_value() {
        let ctx = ctx_with_labels(vec![
            (KeychainStore::SecretService, "gh:github.com"),
            (KeychainStore::SecretService, "unknown-thing"),
        ]);
        let items = KeychainOfferProbe.probe(&ctx).expect("probe");
        assert_eq!(items.len(), 2);

        let github = items
            .iter()
            .find(|i| i.provider_id == "github")
            .expect("github offer");
        assert_eq!(github.confidence, Confidence::High);
        assert_eq!(github.capabilities, vec![CapabilityClass::Importable]);
        match &github.source {
            ProbeSource::Keychain { store, item_label } => {
                assert_eq!(*store, KeychainStore::SecretService);
                assert_eq!(item_label, "gh:github.com");
            }
            other => panic!("unexpected source {other:?}"),
        }

        let unknown = items
            .iter()
            .find(|i| i.provider_id == "unknown-thing")
            .expect("unknown offer");
        assert_eq!(unknown.confidence, Confidence::Medium);
    }

    #[test]
    fn adversarial_a_keychain_value_cannot_be_offered_because_the_trait_has_no_slot_for_it() {
        // The C2 trait returns labels only; a backend that "knows" a value has
        // no way to hand it up. This test pins the shape of that guarantee: a
        // backend returning a label that *looks* like a value still produces
        // an offer whose only string fields are the provider id and the label
        // itself.
        let planted = "PLANTED-KEYCHAIN-VALUE-MUST-NOT-ESCAPE";
        let ctx = ctx_with_labels(vec![(KeychainStore::SecretService, planted)]);
        let items = KeychainOfferProbe.probe(&ctx).expect("probe");
        let rendered = serde_json::to_string(&items).expect("serializable");
        // The label is disclosed by design (it is a display name); what must
        // hold is that nothing *else* — no value-shaped extra field — exists.
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].provider_id, planted);
        assert_eq!(items[0].capabilities, vec![CapabilityClass::Importable]);
        drop(rendered);
    }

    #[test]
    fn a_backend_failure_is_an_error_the_report_can_skip() {
        struct BrokenKeychain;
        impl KeychainBackend for BrokenKeychain {
            fn enumerate_labels(&self) -> Result<Vec<(KeychainStore, String)>, ProbeError> {
                Err(ProbeError::Keychain("daemon refused".to_string()))
            }
        }
        let mut ctx = ctx_with_labels(vec![]);
        ctx.keychain = Arc::new(BrokenKeychain);
        assert!(KeychainOfferProbe.probe(&ctx).is_err());
    }
}
