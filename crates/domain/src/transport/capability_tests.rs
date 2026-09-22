use super::*;
use serde_json::{from_value, json, to_value};

#[test]
fn browser_vault_key_injection_is_unsupported_from_every_constructor() {
    let native = TransportCapabilities::native(
        CapabilityOutcome::Supported,
        CapabilityOutcome::Supported,
        CapabilityOutcome::unsupported("no workload api socket configured"),
        true,
        true,
    );
    let browser = TransportCapabilities::browser();
    for caps in [&native, &browser] {
        assert!(matches!(
            caps.browser_vault_key_injection,
            CapabilityOutcome::Unsupported { .. }
        ));
        assert!(caps.validate().is_ok());
    }
    assert!(!browser.client_presents_certificate);
    assert!(!browser.server_enforces_certificate);
    assert!(matches!(
        browser.browser_managed_external,
        CapabilityOutcome::ExternalProvisioningRequired { .. }
    ));
    assert!(!browser.native_pem.is_supported());
    assert!(native.native_pem.is_supported());
    assert!(!native.browser_managed_external.is_supported());
}

#[test]
fn a_supported_key_injection_cannot_enter_from_the_wire_or_by_hand() {
    let mut wire = to_value(TransportCapabilities::browser()).unwrap();
    assert_eq!(
        wire["browser_vault_key_injection"]["unsupported"]["reason"]
            .as_str()
            .map(str::is_empty),
        Some(false)
    );
    wire["browser_vault_key_injection"] = json!("supported");
    let err = from_value::<TransportCapabilities>(wire.clone())
        .unwrap_err()
        .to_string();
    assert!(err.contains("browser_vault_key_injection"), "{err}");
    wire["browser_vault_key_injection"] =
        json!({ "external_provisioning_required": { "reason": "x" } });
    assert!(from_value::<TransportCapabilities>(wire).is_err());

    let mut by_hand = TransportCapabilities::browser();
    by_hand.browser_vault_key_injection = CapabilityOutcome::Supported;
    assert_eq!(
        by_hand.validate().unwrap_err().code(),
        "malformed_configuration"
    );
    // The helper is the only sanctioned value.
    assert_eq!(
        TransportCapabilities::browser().browser_vault_key_injection,
        browser_vault_key_injection()
    );
}

#[test]
fn outcomes_have_snake_case_wire_forms_and_bounded_reasons() {
    assert_eq!(
        to_value(CapabilityOutcome::Supported).unwrap(),
        json!("supported")
    );
    assert_eq!(
        to_value(CapabilityOutcome::unsupported("why")).unwrap(),
        json!({ "unsupported": { "reason": "why" } })
    );
    assert!(from_value::<CapabilityOutcome>(json!("Supported")).is_err());
    assert!(from_value::<CapabilityOutcome>(json!(true)).is_err());
    assert!(from_value::<CapabilityOutcome>(
        json!({ "unsupported": { "reason": "x", "path": "/k" } })
    )
    .is_err());
    let mut caps = TransportCapabilities::browser();
    caps.native_pem = CapabilityOutcome::unsupported("");
    assert!(caps.validate().is_err());
    caps.native_pem = CapabilityOutcome::unsupported("r".repeat(MAX_REASON_BYTES + 1));
    assert!(caps.validate().is_err());
    caps.native_pem = CapabilityOutcome::unsupported("r".repeat(MAX_REASON_BYTES));
    assert!(caps.validate().is_ok());
}

#[test]
fn presenting_and_enforcing_are_distinct_facts() {
    let client_only = TransportCapabilities::native(
        CapabilityOutcome::Supported,
        CapabilityOutcome::unsupported("n/a"),
        CapabilityOutcome::unsupported("n/a"),
        true,
        false,
    );
    assert!(client_only.client_presents_certificate && !client_only.server_enforces_certificate);
    let wire = to_value(&client_only).unwrap();
    assert_eq!(wire["client_presents_certificate"], json!(true));
    assert_eq!(wire["server_enforces_certificate"], json!(false));
    let mut coerced = wire;
    coerced["server_enforces_certificate"] = json!("false");
    assert!(from_value::<TransportCapabilities>(coerced).is_err());
}
