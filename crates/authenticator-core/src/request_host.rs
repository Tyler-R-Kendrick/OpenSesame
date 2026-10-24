//! Classify request-URI hosts, including IPv4-mapped IPv6 literals.

use std::net::Ipv4Addr;
use url::Url;

fn ipv4_is_blocked(ip: Ipv4Addr) -> bool {
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_unspecified()
}

// These are hostname suffixes, not file extensions: `.local` and `.lan` are
// case-folded mDNS/home-network zones and `lower` is already
// ASCII-lowercased, so the case-sensitive suffix comparison is intended.
#[allow(clippy::case_sensitive_file_extension_comparisons)]
pub(crate) fn host_is_private(url: &Url) -> bool {
    match url.host() {
        None => true,
        Some(url::Host::Domain(host)) => {
            let host = host.trim_end_matches('.');
            let lower = host.to_ascii_lowercase();
            host.eq_ignore_ascii_case("localhost")
                || lower.ends_with(".localhost")
                || lower == "metadata.google.internal"
                || lower.ends_with(".internal")
                || lower.ends_with(".local")
                || lower.ends_with(".lan")
                || lower.ends_with(".home.arpa")
                // Public wildcard DNS services resolve attacker-chosen names
                // to loopback/private addresses without a literal host.
                || lower.ends_with(".nip.io")
                || lower.ends_with(".sslip.io")
                || lower.ends_with(".xip.io")
                || lower.ends_with(".localtest.me")
                || lower.ends_with(".lvh.me")
                || lower.ends_with(".vcap.me")
        }
        Some(url::Host::Ipv4(ip)) => ipv4_is_blocked(ip),
        // Bracketed IPv4-mapped literals stay IPv6 (`::ffff:7f00:1` is 127.0.0.1).
        // The IPv6 flags miss that range, so the embedded address is classified too.
        Some(url::Host::Ipv6(ip)) => {
            ip.to_ipv4_mapped().is_some_and(ipv4_is_blocked)
                || ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.is_multicast()
        }
    }
}
