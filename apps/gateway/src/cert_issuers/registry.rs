//! External certificate issuer registry (ADR 0065 §6).
//!
//! Issuer *rows* are data; trust semantics are not. `IssuerKind` and its
//! `trust()` mapping stay closed in `model.rs` — a community connector may
//! propose an issuer row, but the row's `kind` (and therefore its trust
//! class) is assigned here, in platform code review. Adding a public CA is a
//! one-row diff in this file plus, when its trust class is new, an ADR.

use std::sync::Arc;

use async_trait::async_trait;
use opensesame_connection_broker::ConnectionBroker;
use opensesame_domain::OrganizationId;
use serde_json::Value;

use super::model::IssuerKind;
use super::{Dns01Failure, Dns01Lease, Dns01Provisioner, Dns01Record};

/// How an external issuer's protocol leg is driven. A closed set: the ACME
/// and Cloudflare Origin flows carry the account keys and CSR logic, and
/// those never come from a manifest.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IssuerProtocol {
    Acme,
    CloudflareOriginCa,
}

pub struct ExternalIssuerDescriptor {
    /// Catalog provider id (category `certificates`).
    pub provider_id: &'static str,
    /// Closed-enum kind; carries the platform-owned trust class.
    pub kind: IssuerKind,
    pub label: &'static str,
    pub protocol: IssuerProtocol,
    /// Order tried when no issuer is requested and no default is configured.
    pub default_priority: u8,
}

pub static EXTERNAL_ISSUERS: &[ExternalIssuerDescriptor] = &[
    ExternalIssuerDescriptor {
        provider_id: "letsencrypt",
        kind: IssuerKind::LetsEncrypt,
        label: "Let's Encrypt",
        protocol: IssuerProtocol::Acme,
        default_priority: 0,
    },
    ExternalIssuerDescriptor {
        provider_id: "zerossl",
        kind: IssuerKind::ZeroSsl,
        label: "ZeroSSL",
        protocol: IssuerProtocol::Acme,
        default_priority: 1,
    },
    ExternalIssuerDescriptor {
        provider_id: "cloudflare-origin-ca",
        kind: IssuerKind::CloudflareOriginCa,
        label: "Cloudflare Origin CA",
        protocol: IssuerProtocol::CloudflareOriginCa,
        default_priority: 2,
    },
];

#[must_use]
pub fn issuer_for_provider(provider_id: &str) -> Option<&'static ExternalIssuerDescriptor> {
    EXTERNAL_ISSUERS
        .iter()
        .find(|descriptor| descriptor.provider_id == provider_id)
}

/// Descriptors in default-selection order.
#[must_use]
pub fn issuers_by_priority() -> Vec<&'static ExternalIssuerDescriptor> {
    let mut issuers: Vec<_> = EXTERNAL_ISSUERS.iter().collect();
    issuers.sort_by_key(|descriptor| descriptor.default_priority);
    issuers
}

// ————— Brokered DNS-01 provisioners —————————————————————————————————————

/// A DNS provider's request shape for DNS-01 TXT provisioning, as data.
/// Placeholders: `{zone}` (candidate zone name), `{zone_id}`, `{name}`
/// (record FQDN), `{value}` (key authorization — semi-secret, placed only
/// into the JSON body via encoded substitution), `{record_id}`.
///
/// Every request runs through `ConnectionBroker::authorized_json`, so the
/// connection's egress binding and credential injection apply per call —
/// a shape can name any URL it likes and still only ever reach hosts the
/// connection's catalog row allows.
/// Whether a provider wants the TXT record's `{name}` as the full challenge
/// FQDN (Cloudflare) or relative to the matched zone (`DigitalOcean` appends
/// the domain itself). The two real axes a second provider surfaced.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecordNameStyle {
    Fqdn,
    RelativeToZone,
}

pub struct DnsProviderShape {
    pub provider_id: &'static str,
    /// GET; `{zone}` substituted with each candidate apex while walking up.
    pub zone_lookup_url: &'static str,
    /// JSON pointer to the zone id in the lookup response. For providers whose
    /// zone id *is* the domain name (`DigitalOcean`), point at that name.
    pub zone_id_pointer: &'static str,
    /// POST; `{zone_id}` substituted.
    pub create_url: &'static str,
    /// JSON body template containing `"{name}"` and `"{value}"` in value
    /// position.
    pub create_body: &'static str,
    /// How `{name}` is rendered relative to the zone.
    pub name_style: RecordNameStyle,
    /// JSON pointer to the created record id (string or number).
    pub record_id_pointer: &'static str,
    /// Optional JSON pointer that must be boolean `true` on success. `None`
    /// leans on the HTTP status the broker already enforces (2xx only).
    pub success_pointer: Option<&'static str>,
    /// DELETE; `{zone_id}` and `{record_id}` substituted.
    pub delete_url: &'static str,
}

/// Cloudflare expressed as data — kept template-identical to the wired
/// `CloudflareDns01` implementation (asserted by test below), so promoting
/// the shape to the live path is a proven no-op when that lands.
pub static DNS_PROVIDER_SHAPES: &[DnsProviderShape] = &[
    DnsProviderShape {
        provider_id: "cloudflare",
        zone_lookup_url:
            "https://api.cloudflare.com/client/v4/zones?name={zone}&status=active&per_page=1",
        zone_id_pointer: "/result/0/id",
        create_url: "https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records",
        create_body: r#"{"type":"TXT","name":"{name}","content":"{value}","ttl":60}"#,
        name_style: RecordNameStyle::Fqdn,
        record_id_pointer: "/result/id",
        success_pointer: Some("/success"),
        delete_url: "https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{record_id}",
    },
    DnsProviderShape {
        provider_id: "digitalocean",
        // DO has no search-by-name; a candidate domain that exists returns 200
        // and echoes its own name, which is also the id used downstream.
        zone_lookup_url: "https://api.digitalocean.com/v2/domains/{zone}",
        zone_id_pointer: "/domain/name",
        create_url: "https://api.digitalocean.com/v2/domains/{zone_id}/records",
        create_body: r#"{"type":"TXT","name":"{name}","data":"{value}","ttl":30}"#,
        // DO appends the domain, so the record name is relative to the zone.
        name_style: RecordNameStyle::RelativeToZone,
        // DO record ids are numbers.
        record_id_pointer: "/domain_record/id",
        success_pointer: None,
        delete_url: "https://api.digitalocean.com/v2/domains/{zone_id}/records/{record_id}",
    },
];

#[must_use]
pub fn dns_shape_for_provider(provider_id: &str) -> Option<&'static DnsProviderShape> {
    DNS_PROVIDER_SHAPES
        .iter()
        .find(|shape| shape.provider_id == provider_id)
}

/// Identifiers substituted into URLs must never be able to change the URL's
/// meaning. Providers use opaque ids; anything outside this set is refused.
fn id_is_url_safe(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Zone candidates walked from a `_acme-challenge.` record name: the same
/// label walk `CloudflareDns01` performs.
fn zone_candidates(record_name: &str) -> Option<Vec<String>> {
    let name = record_name.strip_prefix("_acme-challenge.")?;
    let labels: Vec<&str> = name.split('.').collect();
    let mut candidates = Vec::new();
    for start in 0..labels.len().saturating_sub(1) {
        candidates.push(labels[start..].join("."));
    }
    Some(candidates)
}

/// Extract a record/zone id that may be a JSON string or number, keeping the
/// URL-safety fence so a substituted id can never rewrite a URL.
fn extract_id(value: &Value, pointer: &str) -> Option<String> {
    let node = value.pointer(pointer)?;
    let id = match node {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    id_is_url_safe(&id).then_some(id)
}

/// The TXT record name a provider wants: the full challenge FQDN, or that
/// FQDN with the matched zone suffix stripped (a leaf relative to the zone).
fn record_name_for(style: RecordNameStyle, fqdn: &str, zone_name: &str) -> Option<String> {
    match style {
        RecordNameStyle::Fqdn => Some(fqdn.to_owned()),
        RecordNameStyle::RelativeToZone => {
            if fqdn == zone_name {
                return Some("@".to_owned());
            }
            fqdn.strip_suffix(&format!(".{zone_name}"))
                .map(str::to_owned)
        }
    }
}

fn render_create_body(
    shape: &DnsProviderShape,
    record_name: &str,
    record_value: &str,
) -> Option<Value> {
    // JSON-encode both substitutions so no character can escape value
    // position; the template carries "{name}"/"{value}" quoted.
    let name = serde_json::to_string(record_name).ok()?;
    let value = serde_json::to_string(record_value).ok()?;
    let rendered = shape
        .create_body
        .replace("\"{name}\"", &name)
        .replace("\"{value}\"", &value);
    serde_json::from_str(&rendered).ok()
}

pub struct BrokeredDns01 {
    broker: Arc<ConnectionBroker>,
    organization: OrganizationId,
    connection_id: String,
    shape: &'static DnsProviderShape,
}

pub struct BrokeredDnsLease {
    zone_id: String,
    record_id: String,
}

impl BrokeredDns01 {
    pub fn new(
        broker: Arc<ConnectionBroker>,
        organization: OrganizationId,
        connection_id: String,
        shape: &'static DnsProviderShape,
    ) -> Self {
        Self {
            broker,
            organization,
            connection_id,
            shape,
        }
    }

    /// Walk `_acme-challenge.a.b.example.com` up its apexes until a zone
    /// lookup resolves, returning the matched zone *name* (for relative
    /// record-name rendering) and the provider's zone *id*.
    async fn zone(&self, record_name: &str) -> Result<(String, String), Dns01Failure> {
        let candidates = zone_candidates(record_name).ok_or(Dns01Failure::Rejected)?;
        for candidate in candidates {
            if !id_is_url_safe(&candidate.replace('.', "")) {
                return Err(Dns01Failure::Rejected);
            }
            let url = self.shape.zone_lookup_url.replace("{zone}", &candidate);
            // A candidate that is not a zone answers 4xx; keep walking up
            // rather than failing the whole provisioning.
            let Ok(response) = self
                .broker
                .authorized_json(&self.organization, &self.connection_id, "GET", &url, None)
                .await
            else {
                continue;
            };
            if let Some(id) = extract_id(&response, self.shape.zone_id_pointer) {
                return Ok((candidate, id));
            }
        }
        Err(Dns01Failure::Rejected)
    }

    fn success_ok(&self, response: &Value) -> bool {
        match self.shape.success_pointer {
            Some(pointer) => response.pointer(pointer).and_then(Value::as_bool) == Some(true),
            None => true,
        }
    }
}

#[async_trait]
impl Dns01Provisioner for BrokeredDns01 {
    type Lease = BrokeredDnsLease;

    async fn present(&self, record: &Dns01Record) -> Result<Dns01Lease<Self::Lease>, Dns01Failure> {
        let (zone_name, zone_id) = self.zone(record.name()).await?;
        let record_name = record_name_for(self.shape.name_style, record.name(), &zone_name)
            .ok_or(Dns01Failure::Rejected)?;
        let url = self.shape.create_url.replace("{zone_id}", &zone_id);
        let body = render_create_body(self.shape, &record_name, record.value())
            .ok_or(Dns01Failure::Rejected)?;
        let response = self
            .broker
            .authorized_json(
                &self.organization,
                &self.connection_id,
                "POST",
                &url,
                Some(body),
            )
            .await
            .map_err(|_| Dns01Failure::Unavailable)?;
        if !self.success_ok(&response) {
            return Err(Dns01Failure::Rejected);
        }
        let record_id =
            extract_id(&response, self.shape.record_id_pointer).ok_or(Dns01Failure::Rejected)?;
        Ok(Dns01Lease(BrokeredDnsLease { zone_id, record_id }))
    }

    async fn cleanup(
        &self,
        Dns01Lease(lease): Dns01Lease<Self::Lease>,
    ) -> Result<(), Dns01Failure> {
        let url = self
            .shape
            .delete_url
            .replace("{zone_id}", &lease.zone_id)
            .replace("{record_id}", &lease.record_id);
        let response = self
            .broker
            .authorized_json(
                &self.organization,
                &self.connection_id,
                "DELETE",
                &url,
                None,
            )
            .await
            .map_err(|_| Dns01Failure::CleanupFailed)?;
        if self.success_ok(&response) {
            Ok(())
        } else {
            Err(Dns01Failure::CleanupFailed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_rows_agree_with_the_catalog() {
        for descriptor in EXTERNAL_ISSUERS {
            let provider = opensesame_connection_broker::catalog::find(descriptor.provider_id)
                .expect("catalog loads")
                .unwrap_or_else(|| panic!("{} must be in the catalog", descriptor.provider_id));
            assert_eq!(
                provider.category.as_str(),
                "certificates",
                "{} must be categorized as certificates",
                descriptor.provider_id
            );
        }
    }

    #[test]
    fn priorities_are_distinct_and_ordered() {
        let ordered = issuers_by_priority();
        let priorities: Vec<u8> = ordered.iter().map(|d| d.default_priority).collect();
        let mut deduped = priorities.clone();
        deduped.dedup();
        assert_eq!(priorities, deduped, "priorities must be distinct");
        assert_eq!(ordered[0].provider_id, "letsencrypt");
    }

    /// The cloudflare shape must render the exact requests `CloudflareDns01`
    /// issues, so promoting the data path is provably behavior-preserving.
    #[test]
    fn cloudflare_shape_matches_the_wired_implementation() {
        let shape = dns_shape_for_provider("cloudflare").expect("cloudflare shape");
        assert_eq!(
            shape.zone_lookup_url.replace("{zone}", "example.com"),
            "https://api.cloudflare.com/client/v4/zones?name=example.com&status=active&per_page=1"
        );
        assert_eq!(
            shape.create_url.replace("{zone_id}", "abc123"),
            "https://api.cloudflare.com/client/v4/zones/abc123/dns_records"
        );
        assert_eq!(
            shape
                .delete_url
                .replace("{zone_id}", "abc123")
                .replace("{record_id}", "def456"),
            "https://api.cloudflare.com/client/v4/zones/abc123/dns_records/def456"
        );
        let rendered = shape
            .create_body
            .replace("\"{name}\"", "\"_acme-challenge.example.com\"")
            .replace("\"{value}\"", "\"tok\"");
        let body: Value = serde_json::from_str(&rendered).expect("json");
        assert_eq!(
            body,
            serde_json::json!({
                "type": "TXT",
                "name": "_acme-challenge.example.com",
                "content": "tok",
                "ttl": 60,
            })
        );
    }

    #[test]
    fn digitalocean_shape_renders_relative_names_and_numeric_ids() {
        let shape = dns_shape_for_provider("digitalocean").expect("digitalocean shape");
        assert_eq!(shape.name_style, RecordNameStyle::RelativeToZone);

        // Record name relative to the matched zone (DO appends the domain).
        assert_eq!(
            record_name_for(
                RecordNameStyle::RelativeToZone,
                "_acme-challenge.a.b.example.com",
                "example.com",
            ),
            Some("_acme-challenge.a.b".to_owned())
        );
        assert_eq!(
            record_name_for(
                RecordNameStyle::RelativeToZone,
                "example.com",
                "example.com"
            ),
            Some("@".to_owned())
        );
        // A record whose FQDN is not under the zone is refused, not mangled.
        assert_eq!(
            record_name_for(RecordNameStyle::RelativeToZone, "a.evil.com", "example.com"),
            None
        );
        // Fqdn style is unchanged.
        assert_eq!(
            record_name_for(
                RecordNameStyle::Fqdn,
                "_acme-challenge.example.com",
                "example.com"
            ),
            Some("_acme-challenge.example.com".to_owned())
        );

        // Numeric DO record ids extract and stay URL-safe.
        let created = serde_json::json!({ "domain_record": { "id": 3_352_896 } });
        assert_eq!(
            extract_id(&created, shape.record_id_pointer),
            Some("3352896".to_owned())
        );
        // The zone id for DO is the domain name string.
        let zone = serde_json::json!({ "domain": { "name": "example.com" } });
        assert_eq!(
            extract_id(&zone, shape.zone_id_pointer),
            Some("example.com".to_owned())
        );

        // The rendered create body is valid JSON with the relative name.
        let body = render_create_body(shape, "_acme-challenge.a.b", "tok").expect("json");
        assert_eq!(
            body,
            serde_json::json!({"type":"TXT","name":"_acme-challenge.a.b","data":"tok","ttl":30})
        );
    }

    #[test]
    fn extract_id_rejects_non_scalar_and_unsafe_values() {
        let v = serde_json::json!({ "a": { "id": "ok-1" }, "b": { "id": ["x"] }, "c": { "id": "../x" } });
        assert_eq!(extract_id(&v, "/a/id"), Some("ok-1".to_owned()));
        assert_eq!(extract_id(&v, "/b/id"), None);
        assert_eq!(extract_id(&v, "/c/id"), None);
        assert_eq!(extract_id(&v, "/missing"), None);
    }

    #[test]
    fn zone_walk_matches_the_wired_implementation() {
        assert_eq!(
            zone_candidates("_acme-challenge.a.b.example.com").unwrap(),
            vec!["a.b.example.com", "b.example.com", "example.com"]
        );
        assert!(zone_candidates("no-prefix.example.com").is_none());
    }

    #[test]
    fn substituted_ids_cannot_rewrite_urls() {
        assert!(id_is_url_safe("023e105f4ecef8ad9ca31a8372d0c353"));
        assert!(!id_is_url_safe("../../zones"));
        assert!(!id_is_url_safe("id?admin=true"));
        assert!(!id_is_url_safe(""));
    }
}
