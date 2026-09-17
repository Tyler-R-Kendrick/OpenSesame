//! Issuance preflight: refuse a grant whose platform cannot hold its terms.
//!
//! Catalog lookup lives here so the Host issue path does not construct
//! descriptors itself, and an unknown or absent platform is a refusal rather
//! than a silent default.

use crate::enforcement_gate::{admit, EnforcementRefused};
use opensesame_domain::InvokeLevel;
use opensesame_enforcement::{
    catalog, requirements_for, Admitted, EnforcementDescriptor, GrantTerms, OfflineUse,
};

pub use opensesame_enforcement::GrantTerms as IssuanceGrantTerms;

/// Judge grant terms against a named catalog platform before the sidecar exists.
///
/// # Errors
///
/// [`EnforcementRefused`] when the platform is unknown, the catalog cannot
/// load, or a dimension is unmet (including every `AdapterStatus::Absent`
/// entry).
pub fn admit_issuance(platform: &str, terms: GrantTerms) -> Result<Admitted, EnforcementRefused> {
    let descriptor = descriptor_named(platform)?;
    admit(&requirements_for(terms), &descriptor)
}

/// Descriptor the invoke path must judge against for this level.
///
/// Typed and constrained-HTTP uses run on `host-brokered-invocation`.
/// Materialize runs on `host-minted-token`, so a sealed grant
/// (`raw_credential_export = false`) is refused rather than minted.
///
/// # Errors
///
/// [`EnforcementRefused::CatalogUnusable`] or
/// [`EnforcementRefused::UnknownPlatform`].
pub fn descriptor_for_invoke(
    level: InvokeLevel,
) -> Result<EnforcementDescriptor, EnforcementRefused> {
    let platform = match level {
        InvokeLevel::TypedOperation | InvokeLevel::ConstrainedHttp => "host-brokered-invocation",
        InvokeLevel::Materialize => "host-minted-token",
    };
    descriptor_named(platform)
}

fn descriptor_named(platform: &str) -> Result<EnforcementDescriptor, EnforcementRefused> {
    let built = catalog().map_err(|_| EnforcementRefused::CatalogUnusable)?;
    built
        .find(platform)
        .copied()
        .ok_or_else(|| EnforcementRefused::UnknownPlatform(platform.to_owned()))
}

/// Parse the issue-body `offline_use` wire name.
///
/// # Errors
///
/// Returns the original string when it is not a known variant.
pub fn parse_offline_use(raw: Option<&str>) -> Result<OfflineUse, String> {
    match raw.unwrap_or("forbidden") {
        "forbidden" => Ok(OfflineUse::Forbidden),
        "read_only" => Ok(OfflineUse::ReadOnly),
        "pre_authorized" => Ok(OfflineUse::PreAuthorized),
        other => Err(other.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::{admit_issuance, descriptor_for_invoke, parse_offline_use};
    use crate::EnforcementRefused;
    use opensesame_domain::InvokeLevel;
    use opensesame_enforcement::{GrantTerms, OfflineUse};

    const SEALED: GrantTerms = GrantTerms {
        offline_use: OfflineUse::Forbidden,
        raw_credential_export: false,
    };

    #[test]
    fn brokered_issuance_is_admitted() {
        admit_issuance("host-brokered-invocation", SEALED).expect("broker holds sealed terms");
    }

    #[test]
    fn absent_platforms_are_refused() {
        for platform in ["apple-ios", "android", "discord-live", "blocky-live-saas"] {
            let error = admit_issuance(platform, SEALED)
                .expect_err("an absent adapter cannot carry a sealed grant");
            match error {
                EnforcementRefused::CannotHold(refusal) => {
                    assert_eq!(refusal.platform, platform);
                    assert!(refusal.cites_unsupported(), "{platform}");
                }
                other => panic!("{platform} should be a shortfall, got {other:?}"),
            }
        }
    }

    #[test]
    fn unknown_platform_is_refused() {
        let error = admit_issuance("not-a-platform", SEALED).expect_err("unknown");
        assert!(
            matches!(error, EnforcementRefused::UnknownPlatform(name) if name == "not-a-platform")
        );
    }

    #[test]
    fn materialize_descriptor_is_minted_token() {
        let descriptor = descriptor_for_invoke(InvokeLevel::Materialize).expect("catalog");
        assert_eq!(descriptor.platform(), "host-minted-token");
    }

    #[test]
    fn offline_use_wire_names() {
        assert_eq!(parse_offline_use(None).unwrap(), OfflineUse::Forbidden);
        assert_eq!(
            parse_offline_use(Some("pre_authorized")).unwrap(),
            OfflineUse::PreAuthorized
        );
        assert!(parse_offline_use(Some("offline-please")).is_err());
    }
}
