//! Stack construction internals: the mock Host listener, the bridge-core
//! factory and the passive recorder. Split out of `live_support` for the
//! 400-line module budget (ADR 0093); behavior is unchanged.

use std::sync::{Arc, Mutex};

use futures::StreamExt as _;
use opensesame_domain::transport::{TransportPolicy, TrustProfileRef};
use opensesame_nats_callout::bridge::BridgeCore;
use opensesame_nats_callout::host_client::HttpHost;
use opensesame_nats_callout::response::ResponseSigner;
use opensesame_nats_callout::xkey::CalloutXKey;
use opensesame_nats_callout::{AUTH_SUBJECT, SERVER_XKEY_HEADER};
use opensesame_transport_security::{
    Generation, SecureListener, ServerProfile, TransportGenerations,
};

use super::{host, pki, server, MockHost, RecordedEnvelope};

pub(super) fn build_core(
    pki: &pki::Pki,
    account_seed: &str,
    host_url: &url::Url,
    worker_certificate: bool,
    xkey: Option<CalloutXKey>,
) -> BridgeCore {
    let profile = if worker_certificate {
        pki.worker_to_host()
    } else {
        pki.bridge_to_host()
    };
    BridgeCore {
        signer: ResponseSigner::from_seed(account_seed, 300).expect("signer"),
        server_public_keys: vec![],
        xkey,
        target_account: server::APP_ACCOUNT.to_owned(),
        callout_subject: None,
        source: Arc::new(HttpHost::new(&profile, host_url).expect("host client")),
    }
}

pub(super) async fn start_host(
    pki: &pki::Pki,
    host: Arc<MockHost>,
) -> (url::Url, tokio::sync::oneshot::Sender<()>) {
    let identity = Arc::new(pki.host_server.identity());
    let trust = pki.trust();
    let profile_name = TrustProfileRef::new(pki::CLIENT_TRUST_PROFILE).expect("profile");
    let generation = Generation {
        number: 1,
        identity: Some(Arc::clone(&identity)),
        peer_trust: [(profile_name, trust)].into_iter().collect(),
        activated_at: chrono::Utc::now(),
        withdrawn: None,
    };
    let generations = TransportGenerations::new(generation);
    let listener = SecureListener::bind(
        "127.0.0.1:0".parse().expect("addr"),
        Arc::clone(&generations),
        move |generation| {
            let identity = generation
                .identity
                .clone()
                .ok_or(opensesame_domain::transport::TransportError::IdentityMissing)?;
            let trust = generation
                .trust(&TrustProfileRef::new(pki::CLIENT_TRUST_PROFILE).expect("profile"))?
                .clone();
            let mut profile =
                ServerProfile::new(TransportPolicy::MtlsRequired, identity, "mock-host");
            profile.client_trust = Some(trust);
            Ok(profile)
        },
    )
    .await
    .expect("mock host listener");
    let addr = listener.local_addr();
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _ = listener
            .serve_until(host::router(host), async {
                let _ = rx.await;
            })
            .await;
    });
    let url =
        url::Url::parse(&format!("https://{}:{}", pki::HOST_DNS, addr.port())).expect("host url");
    (url, tx)
}

/// The callout xkey named by a stack's seed.
pub(super) fn xkey_from(seed: Option<&str>) -> Option<CalloutXKey> {
    seed.map(|s| CalloutXKey::from_seed(s).expect("xkey seed"))
}

/// A passive plain subscriber on the protected subject: it records every
/// callout envelope exactly as the server sent it (payload and
/// `Nats-Server-Xkey` header) and never answers — the queue-group bridge is
/// the only responder, so recording cannot change any decision.
pub(super) fn spawn_recorder(
    client: async_nats::Client,
    envelopes: Arc<Mutex<Vec<RecordedEnvelope>>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let Ok(mut sub) = client.subscribe(AUTH_SUBJECT).await else {
            return;
        };
        while let Some(message) = sub.next().await {
            let server_xkey_header = message
                .headers
                .as_ref()
                .and_then(|h| h.get(SERVER_XKEY_HEADER))
                .map(|v| v.as_str().to_owned());
            envelopes.lock().expect("envelopes").push(RecordedEnvelope {
                payload: message.payload.to_vec(),
                server_xkey_header,
            });
        }
    })
}
