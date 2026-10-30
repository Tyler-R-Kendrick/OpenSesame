//! Authoritative EST password-budget identity; request headers carry no authority.
use std::net::{IpAddr, SocketAddr};

use axum::{
    extract::ConnectInfo,
    http::{Extensions, StatusCode},
    response::Response,
};
use hmac::{Hmac, Mac};
use opensesame_domain::transport::{EvidenceSource, TransportPolicy};
use opensesame_ingress_evidence::OriginatingPeerExtension;
use opensesame_storage::StoredEstConfig;
use opensesame_transport_security::PeerExtension;
use sha2::Sha256;

use crate::app_state::AppState;
use crate::routes::est_server::{internal, refuse, sealing_key};

fn unavailable() -> Response {
    refuse(
        StatusCode::SERVICE_UNAVAILABLE,
        "trusted_source_required",
        "EST password authentication requires a network peer or verified originating client",
    )
}

fn source(extensions: &Extensions) -> Result<String, Response> {
    let peer = extensions
        .get::<PeerExtension>()
        .map(|peer| peer.0.as_ref());
    if let Some(OriginatingPeerExtension(origin)) = extensions.get::<OriginatingPeerExtension>() {
        let now = chrono::Utc::now();
        let linked = peer.is_some_and(|proxy| {
            proxy.source() == EvidenceSource::DirectTls
                && proxy.policy() == TransportPolicy::TrustedIngress
                && proxy.is_usable_at(now)
                && origin.ingress().is_some_and(|ingress| {
                    ingress.leaf_thumbprint_sha256() == proxy.leaf_thumbprint_sha256()
                        && ingress.listener() == proxy.listener()
                })
        });
        if !linked
            || origin.source() != EvidenceSource::TrustedIngressAssertion
            || origin.policy() != TransportPolicy::TrustedIngress
            || !origin.is_usable_at(now)
        {
            return Err(unavailable());
        }
        return Ok(format!(
            "originating-tls:{}",
            origin.leaf_thumbprint_sha256()
        ));
    }
    // Without originating evidence a shared proxy address would recreate the
    // profile-wide lockout for all of its downstream clients. Never use XFF.
    if peer.is_some_and(|peer| peer.policy() == TransportPolicy::TrustedIngress) {
        return Err(unavailable());
    }
    let Some(ConnectInfo(remote)) = extensions.get::<ConnectInfo<SocketAddr>>() else {
        return Err(unavailable());
    };
    let ip = remote.ip().to_canonical();
    if ip.is_unspecified() || ip.is_multicast() {
        return Err(unavailable());
    }
    Ok(match ip {
        IpAddr::V4(ip) => format!("ipv4:{ip}"),
        // One interface cannot mint fresh budgets by rotating its lower 64 bits.
        IpAddr::V6(ip) => format!("ipv6-prefix:{:016x}", u128::from(ip) >> 64),
    })
}

pub(super) fn bucket(
    st: &AppState,
    config: &StoredEstConfig,
    extensions: &Extensions,
) -> Result<String, Response> {
    let source = source(extensions)?;
    let key = sealing_key(st)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key)
        .map_err(|error| internal(error, "derive EST source budget"))?;
    mac.update(b"opensesame:est-source-budget:v1");
    // Lengths bind distinct profiles/organizations without ambiguous separators.
    for field in [&config.organization_id, &config.id, &source] {
        mac.update(&(field.len() as u64).to_be_bytes());
        mac.update(field.as_bytes());
    }
    Ok(hex::encode(mac.finalize().into_bytes()))
}

#[cfg(test)]
#[path = "est_budget_source_tests.rs"]
mod tests;
