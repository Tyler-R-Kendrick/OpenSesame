//! Where the mint may sign a request to: STS's regional endpoint for the
//! binding's region, and nothing else.
//!
//! The table is a compile-time constant, like `rotation_egress.rs`, so no data
//! decides what the fence permits: a region missing from it is refused when the
//! binding is written, and each mint's egress rule names exactly one host. The
//! rule is the broker's own and is never added to the daemon's
//! `EGRESS_RULES` (ADR 0052 §7).

use opensesame_invoke_through::{AuthStyle, EgressRule};

/// The egress rule's provider id. Not a catalog provider: the rule exists only
/// for the mint's own call.
pub const STS_PROVIDER: &str = "aws-sts";

/// Regions and their regional STS hosts, AWS's documented
/// `sts.<region>.amazonaws.com` (`.amazonaws.com.cn` in the China partition).
static STS_REGIONS: &[(&str, &str)] = &[
    ("af-south-1", "sts.af-south-1.amazonaws.com"),
    ("ap-east-1", "sts.ap-east-1.amazonaws.com"),
    ("ap-east-2", "sts.ap-east-2.amazonaws.com"),
    ("ap-northeast-1", "sts.ap-northeast-1.amazonaws.com"),
    ("ap-northeast-2", "sts.ap-northeast-2.amazonaws.com"),
    ("ap-northeast-3", "sts.ap-northeast-3.amazonaws.com"),
    ("ap-south-1", "sts.ap-south-1.amazonaws.com"),
    ("ap-south-2", "sts.ap-south-2.amazonaws.com"),
    ("ap-southeast-1", "sts.ap-southeast-1.amazonaws.com"),
    ("ap-southeast-2", "sts.ap-southeast-2.amazonaws.com"),
    ("ap-southeast-3", "sts.ap-southeast-3.amazonaws.com"),
    ("ap-southeast-4", "sts.ap-southeast-4.amazonaws.com"),
    ("ap-southeast-5", "sts.ap-southeast-5.amazonaws.com"),
    ("ap-southeast-6", "sts.ap-southeast-6.amazonaws.com"),
    ("ap-southeast-7", "sts.ap-southeast-7.amazonaws.com"),
    ("ca-central-1", "sts.ca-central-1.amazonaws.com"),
    ("ca-west-1", "sts.ca-west-1.amazonaws.com"),
    ("cn-north-1", "sts.cn-north-1.amazonaws.com.cn"),
    ("cn-northwest-1", "sts.cn-northwest-1.amazonaws.com.cn"),
    ("eu-central-1", "sts.eu-central-1.amazonaws.com"),
    ("eu-central-2", "sts.eu-central-2.amazonaws.com"),
    ("eu-north-1", "sts.eu-north-1.amazonaws.com"),
    ("eu-south-1", "sts.eu-south-1.amazonaws.com"),
    ("eu-south-2", "sts.eu-south-2.amazonaws.com"),
    ("eu-west-1", "sts.eu-west-1.amazonaws.com"),
    ("eu-west-2", "sts.eu-west-2.amazonaws.com"),
    ("eu-west-3", "sts.eu-west-3.amazonaws.com"),
    ("il-central-1", "sts.il-central-1.amazonaws.com"),
    ("me-central-1", "sts.me-central-1.amazonaws.com"),
    ("me-south-1", "sts.me-south-1.amazonaws.com"),
    ("mx-central-1", "sts.mx-central-1.amazonaws.com"),
    ("sa-east-1", "sts.sa-east-1.amazonaws.com"),
    ("us-east-1", "sts.us-east-1.amazonaws.com"),
    ("us-east-2", "sts.us-east-2.amazonaws.com"),
    ("us-gov-east-1", "sts.us-gov-east-1.amazonaws.com"),
    ("us-gov-west-1", "sts.us-gov-west-1.amazonaws.com"),
    ("us-west-1", "sts.us-west-1.amazonaws.com"),
    ("us-west-2", "sts.us-west-2.amazonaws.com"),
];

/// Hosts a test override may name: loopback only, reached over plain HTTP
/// only because the invoker is built with `allow_http_for_tests`.
static LOOPBACK: &[&str] = &["127.0.0.1", "localhost"];

/// The regional host for `region`, when the table knows it.
#[must_use]
pub fn regional_host(region: &str) -> Option<&'static str> {
    STS_REGIONS
        .iter()
        .find(|(known, _)| *known == region)
        .map(|(_, host)| *host)
}

/// Where one mint sends its request, and the single-host rule that clears it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StsEndpoint {
    pub url: String,
    pub rule: EgressRule,
    /// Whether the invoker must permit loopback HTTP (a test stand-in only).
    pub loopback: bool,
}

/// The endpoint for `region`: the regional host, or — when the deployment was
/// built in-process with an override (`BrokerConfig::with_aws_sts_endpoint`,
/// never read from the environment) — that loopback URL.
#[must_use]
pub fn endpoint(region: &str, override_url: Option<&str>) -> Option<StsEndpoint> {
    if let Some(url) = override_url {
        return Some(StsEndpoint {
            url: format!("{}/", url.trim_end_matches('/')),
            rule: rule(LOOPBACK),
            loopback: true,
        });
    }
    let index = STS_REGIONS.iter().position(|(known, _)| *known == region)?;
    Some(StsEndpoint {
        url: format!("https://{}/", STS_REGIONS[index].1),
        rule: rule(std::slice::from_ref(&STS_REGIONS[index].1)),
        loopback: false,
    })
}

fn rule(hosts: &'static [&'static str]) -> EgressRule {
    EgressRule {
        provider_id: STS_PROVIDER,
        scheme: "https",
        hosts,
        auth: AuthStyle::SigV4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_mint_is_cleared_for_its_own_region_alone() {
        let found = endpoint("eu-west-1", None).expect("known region");
        assert_eq!(found.url, "https://sts.eu-west-1.amazonaws.com/");
        assert_eq!(found.rule.hosts, ["sts.eu-west-1.amazonaws.com"]);
        assert_eq!(found.rule.auth, AuthStyle::SigV4);
        assert!(!found.loopback);
        assert_eq!(
            regional_host("cn-north-1"),
            Some("sts.cn-north-1.amazonaws.com.cn")
        );
    }

    #[test]
    fn an_unknown_region_has_no_endpoint() {
        for region in ["", "us-east-1.evil.test", "moon-1", "US-EAST-1"] {
            assert!(endpoint(region, None).is_none(), "{region}");
        }
    }

    #[test]
    fn the_table_is_sorted_and_every_host_is_the_documented_form() {
        assert!(STS_REGIONS.windows(2).all(|pair| pair[0].0 < pair[1].0));
        for (region, host) in STS_REGIONS {
            let suffix = if region.starts_with("cn-") {
                ".amazonaws.com.cn"
            } else {
                ".amazonaws.com"
            };
            assert_eq!(*host, format!("sts.{region}{suffix}"));
        }
    }
}
