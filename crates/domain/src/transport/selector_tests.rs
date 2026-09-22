use super::*;
use serde_json::{from_value, json, to_value};

const HEX: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn parse(v: serde_json::Value) -> Result<PeerIdentitySelector, String> {
    from_value(v).map_err(|e| e.to_string())
}

#[test]
fn well_formed_selectors_round_trip() {
    let cases = [
        (
            json!({ "spiffe_id": "spiffe://example.org/ns/prod/sa/gateway" }),
            "spiffe://example.org/ns/prod/sa/gateway",
        ),
        (
            json!({ "spiffe_id": "spiffe://td/Mixed.Case_seg-1" }),
            "spiffe://td/Mixed.Case_seg-1",
        ),
        (
            json!({ "dns_name": "gateway.internal.example" }),
            "gateway.internal.example",
        ),
        (json!({ "dns_name": "localhost" }), "localhost"),
        (
            json!({ "dns_name": "a1.b2-c3.example" }),
            "a1.b2-c3.example",
        ),
        (
            json!({ "uri_san": "urn:opensesame:worker:alpha" }),
            "urn:opensesame:worker:alpha",
        ),
        (
            json!({ "uri_san": "https://worker.example/id/1" }),
            "https://worker.example/id/1",
        ),
        (json!({ "leaf_thumbprint_sha256": HEX }), HEX),
    ];
    for (wire, value) in cases {
        let parsed = parse(wire.clone()).unwrap_or_else(|e| panic!("{wire}: {e}"));
        assert_eq!(parsed.value(), value);
        assert_eq!(to_value(&parsed).unwrap(), wire);
        assert!(parsed.validate().is_ok());
    }
}

#[test]
fn malformed_selectors_are_refused_on_the_wire() {
    let long_dns = format!("{}.example", "a".repeat(250));
    let long_spiffe = format!("spiffe://td/{}", "a".repeat(2048));
    let cases: Vec<(serde_json::Value, &str)> = vec![
        (json!({ "dns_name": "Gateway.Example" }), "uppercase DNS"),
        (json!({ "dns_name": "*.example" }), "wildcard"),
        (json!({ "dns_name": "gateway.example." }), "trailing dot"),
        (json!({ "dns_name": "10.0.0.1" }), "IPv4"),
        (json!({ "dns_name": "::1" }), "IPv6"),
        (json!({ "dns_name": "fe80::1" }), "IPv6 literal"),
        (json!({ "dns_name": "user@example.com" }), "email as DNS"),
        (json!({ "dns_name": "gatewäy.example" }), "IDN"),
        (json!({ "dns_name": "-lead.example" }), "leading hyphen"),
        (json!({ "dns_name": "a..b" }), "empty label"),
        (json!({ "dns_name": "" }), "empty"),
        (json!({ "dns_name": long_dns }), "> 253 bytes"),
        (json!({ "dns_name": "gate_way.example" }), "underscore"),
        (json!({ "common_name": "gateway" }), "CN"),
        (json!({ "email": "ops@example.com" }), "email variant"),
        (json!({ "ip": "10.0.0.1" }), "IP variant"),
        (
            json!({ "spiffe_id": "spiffe://example.org" }),
            "trust domain only",
        ),
        (
            json!({ "spiffe_id": "spiffe://Example.org/x" }),
            "uppercase trust domain",
        ),
        (
            json!({ "spiffe_id": "spiffe://exаmple.org/x" }),
            "Cyrillic a confusable",
        ),
        (
            json!({ "spiffe_id": "spiffe://example.org/x/../y" }),
            "dot-dot segment",
        ),
        (
            json!({ "spiffe_id": "spiffe://example.org//x" }),
            "empty segment",
        ),
        (
            json!({ "spiffe_id": "spiffe://example.org/x/" }),
            "trailing slash",
        ),
        (
            json!({ "spiffe_id": "spiffe://example.org/x?y=1" }),
            "query",
        ),
        (
            json!({ "spiffe_id": "spiffe://example.org/x%20y" }),
            "percent",
        ),
        (
            json!({ "spiffe_id": "SPIFFE://example.org/x" }),
            "uppercase scheme",
        ),
        (
            json!({ "spiffe_id": "http://example.org/x" }),
            "wrong scheme",
        ),
        (json!({ "spiffe_id": long_spiffe }), "> 2048 bytes"),
        (
            json!({ "spiffe_id": "spiffe://example.org/*" }),
            "wildcard path",
        ),
        (
            json!({ "uri_san": "spiffe://example.org/x" }),
            "spiffe as uri_san",
        ),
        (json!({ "uri_san": "mailto:ops@example.com" }), "mailto"),
        (json!({ "uri_san": "urn:x:ops@example" }), "at sign"),
        (json!({ "uri_san": "no-scheme" }), "no scheme"),
        (json!({ "uri_san": "HTTPS://x" }), "uppercase scheme"),
        (json!({ "uri_san": "urn:x:*" }), "wildcard"),
        (json!({ "uri_san": "urn:x:a#frag" }), "fragment"),
        (json!({ "uri_san": "urn:x:a b" }), "space"),
        (json!({ "uri_san": "" }), "empty"),
        (
            json!({ "leaf_thumbprint_sha256": HEX.to_ascii_uppercase() }),
            "uppercase hex",
        ),
        (json!({ "leaf_thumbprint_sha256": &HEX[..63] }), "short hex"),
        (
            json!({ "leaf_thumbprint_sha256": format!("sha256:{HEX}") }),
            "prefixed hex",
        ),
        (json!("gateway.example"), "bare string"),
        (
            json!({ "dns_name": "a.example", "uri_san": "urn:x" }),
            "two keys",
        ),
        (json!({ "dns_name": 1 }), "number"),
        (json!({ "dns_name": null }), "null"),
        (json!({}), "empty object"),
    ];
    for (wire, why) in cases {
        assert!(parse(wire.clone()).is_err(), "{why}: {wire}");
    }
}

#[test]
fn hand_built_selectors_are_caught_by_validate() {
    let bad = PeerIdentitySelector::DnsName("Gateway".into());
    assert_eq!(
        bad.validate().unwrap_err().code(),
        "malformed_configuration"
    );
    assert!(PeerIdentitySelector::LeafThumbprintSha256(HEX.into()).is_thumbprint());
    assert!(!PeerIdentitySelector::DnsName("a.example".into()).is_thumbprint());
}
