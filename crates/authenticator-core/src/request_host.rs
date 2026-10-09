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

pub(crate) fn host_is_private(url: &Url) -> bool {
    match url.host() {
        None => true,
        Some(url::Host::Domain(host)) => {
            let host = host.trim_end_matches('.');
            host.eq_ignore_ascii_case("localhost")
                || host.to_ascii_lowercase().ends_with(".localhost")
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
