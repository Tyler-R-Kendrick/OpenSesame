//! Building one scoped connector client: which addresses it may dial, and
//! the TLS profile it presents (ADR 0130, CONN-POOLS/CONN-EXECUTE).
//!
//! Two fences live here. The **address** fence refuses an upstream that
//! resolves to somebody's internal network — loopback, link-local, private,
//! carrier-NAT, unique-local — because a public-looking name whose DNS answer
//! points inward is exactly how a credentialed request gets aimed at a
//! metadata service (AT-CONNECTOR-EGRESS). The **profile** fence is that the
//! client is built from the *resolved* trust bundle and identity only: the
//! injected `rustls::ClientConfig` is the whole of its trust, it is https
//! only, it verifies the exact configured server identity whatever address it
//! dialed, and it is pinned to the one authority the egress fence cleared.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use opensesame_domain::transport::TransportError;
use opensesame_invoke_through::{EgressRule, Invoker, TlsClientSpec};
use opensesame_transport_security::{
    client_config, dial_name, ClientProfile, TlsIdentity, TrustBundle,
};

use super::ConnectionTransport;

/// An address no upstream connector may be dialed at, whatever DNS answered:
/// loopback, link-local, private, unspecified, multicast, or IPv6 unique-local.
/// Checked on the *resolved* address, after the name lookup, because a name
/// that looks public may answer with an internal one.
#[must_use]
pub fn is_internal(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.octets()[0] == 0
                // 100.64.0.0/10 (RFC 6598 carrier NAT) and 169.254.0.0/16 are
                // both routes to somebody else's internal network.
                || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // fe80::/10 link-local and fc00::/7 unique-local.
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || v6.to_ipv4_mapped().is_some_and(is_internal_v4)
        }
    }
}

fn is_internal_v4(v4: std::net::Ipv4Addr) -> bool {
    is_internal(IpAddr::V4(v4))
}

/// The one authority a pooled client may dial, and the addresses the fence
/// already cleared for it.
#[derive(Clone, Debug)]
pub struct PinnedAuthority {
    pub label: String,
    pub host: String,
    pub addrs: Vec<SocketAddr>,
}

/// The one client for one scope.
///
/// # Errors
///
/// `MalformedConfiguration` when a configured trust profile has no server
/// name, or when the client config cannot be built from the resolved profile.
pub fn build_invoker(
    transport: &ConnectionTransport,
    identity: Option<&Arc<TlsIdentity>>,
    trust: Option<&Arc<TrustBundle>>,
    authority: &PinnedAuthority,
    rules: Vec<EgressRule>,
    allow_loopback: bool,
) -> Result<Invoker, TransportError> {
    let Some(trust) = trust else {
        // No configured trust profile: the connection uses the Host's ordinary
        // Web PKI client. `mtls_required` never reaches here — `resolve_trust`
        // refuses it — so this is only the unchanged `server_tls` path.
        let invoker = Invoker::with_rules(rules);
        return Ok(if allow_loopback {
            invoker.allow_http_for_tests()
        } else {
            invoker
        });
    };
    let server_name = transport
        .server_name
        .as_ref()
        .ok_or_else(|| TransportError::malformed("a trust profile requires a server name"))?
        .policy();
    let profile = ClientProfile {
        server_trust: trust.as_ref().clone(),
        server_name: server_name.clone(),
        identity: identity.map(Arc::clone),
        min_version: opensesame_domain::transport::TlsVersion::Tls13,
    };
    let config = client_config(&profile)?;
    let spec = TlsClientSpec {
        config: Arc::new(config),
        server_name: Some(dial_name(&server_name, &authority.host)?),
        pinned: Some((authority.host.clone(), authority.addrs.clone())),
    };
    let invoker = Invoker::with_tls(rules, &spec);
    Ok(if allow_loopback {
        invoker.allow_http_for_tests()
    } else {
        invoker
    })
}
