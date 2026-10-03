//! Live sync (ADR 0148 §7): the `/notifications/hub` websocket Bitwarden
//! clients hold open, speaking `SignalR`'s `MessagePack` protocol.
//!
//! A client connects with its access token, answers the handshake, and is
//! then told when its account's vault changed (it syncs) or its security
//! stamp changed (it signs out). The hub carries no vault data — only "sync
//! now" and "sign out", and the account id they are for — so what a client
//! learns from it is what polling `/accounts/revision-date` would tell it,
//! sooner.

mod anonymous;
pub mod frames;

pub use anonymous::anonymous_hub;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::header::AUTHORIZATION;
use axum::http::HeaderMap;
use axum::response::Response;
use chrono::Utc;
use serde::Deserialize;
use tokio::sync::mpsc;

use crate::error::{ApiError, ApiResult};
use crate::BitwardenServer;
use frames::Update;

/// Open connections one account may hold; a client holds one per window.
const PER_ACCOUNT: usize = 32;
/// Frames queued for a slow connection before it misses one; a missed
/// "sync now" is caught by the client's next sync.
const QUEUE: usize = 16;
const PING_EVERY: Duration = Duration::from_secs(15);

/// Anonymous connections, waiting on sign-in requests, the hub holds at once.
const WAITING: usize = 1024;

type Senders = Vec<(u64, mpsc::Sender<Vec<u8>>)>;

/// Connections by key, each with a queue.
#[derive(Clone, Default)]
struct Registry {
    connections: Arc<Mutex<HashMap<String, Senders>>>,
    next: Arc<AtomicU64>,
}

/// A connection's place in a registry; leaving drops it.
pub(crate) struct Seat {
    registry: Registry,
    key: String,
    id: u64,
}

impl Drop for Seat {
    fn drop(&mut self) {
        let mut connections = self.registry.lock();
        if let Some(list) = connections.get_mut(&self.key) {
            list.retain(|(id, _)| *id != self.id);
            if list.is_empty() {
                connections.remove(&self.key);
            }
        }
    }
}

impl Registry {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Senders>> {
        self.connections
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A seat under `key`, if it holds fewer than `per_key` and the whole
    /// registry fewer than `total`.
    fn join(
        &self,
        key: &str,
        per_key: usize,
        total: usize,
    ) -> Option<(Seat, mpsc::Receiver<Vec<u8>>)> {
        let mut connections = self.lock();
        let held: usize = connections.values().map(Vec::len).sum();
        let list = connections.entry(key.to_owned()).or_default();
        if list.len() >= per_key || held >= total {
            return None;
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel(QUEUE);
        list.push((id, tx));
        Some((
            Seat {
                registry: self.clone(),
                key: key.to_owned(),
                id,
            },
            rx,
        ))
    }

    fn send(&self, key: &str, frame: &[u8], close: bool) {
        let mut connections = self.lock();
        if let Some(list) = connections.get(key) {
            for (_, tx) in list {
                // A full queue already holds a "sync now"; nothing is lost.
                let _ = tx.try_send(frame.to_vec());
            }
        }
        if close {
            // The senders go; each connection drains its queue, then ends.
            connections.remove(key);
        }
    }
}

/// Who is connected: accounts' clients, and devices waiting on a sign-in
/// request they made.
#[derive(Clone, Default)]
pub struct Hub {
    accounts: Registry,
    waiting: Registry,
}

impl Hub {
    fn join(&self, user_id: &str) -> Option<(Seat, mpsc::Receiver<Vec<u8>>)> {
        self.accounts.join(user_id, PER_ACCOUNT, usize::MAX)
    }

    /// Tell the account's clients its vault changed.
    pub fn vault_changed(&self, user_id: &str) {
        let frame = frames::update(Update::SyncVault, user_id, Utc::now());
        self.accounts.send(user_id, &frame, false);
    }

    /// Tell the account's clients to sign out, and close their connections.
    pub fn signed_out(&self, user_id: &str) {
        let frame = frames::update(Update::LogOut, user_id, Utc::now());
        self.accounts.send(user_id, &frame, true);
    }

    /// Tell the account's clients a device asks to sign in.
    pub fn sign_in_requested(&self, user_id: &str, request_id: &str) {
        let frame = frames::request_update(Update::AuthRequest, user_id, request_id);
        self.accounts.send(user_id, &frame, false);
    }

    /// Tell the account's clients, and the device waiting on it, that a
    /// request was answered; the waiting device's connection then ends.
    pub fn sign_in_answered(&self, user_id: &str, request_id: &str) {
        let frame = frames::request_update(Update::AuthRequestResponse, user_id, request_id);
        self.accounts.send(user_id, &frame, false);
        let answer = frames::anonymous_response(user_id, request_id);
        self.waiting.send(request_id, &answer, true);
    }

    /// How many connections the account holds.
    #[must_use]
    pub fn connected(&self, user_id: &str) -> usize {
        self.accounts.lock().get(user_id).map_or(0, Vec::len)
    }
}

#[derive(Deserialize)]
pub struct HubQuery {
    access_token: Option<String>,
}

/// `GET /notifications/hub?access_token=…`: upgrade to the hub, for a
/// token whose security stamp is current.
///
/// # Errors
///
/// 401 without a current token, 429 when the account holds too many
/// connections already.
pub async fn hub(
    State(server): State<BitwardenServer>,
    Query(query): Query<HubQuery>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> ApiResult<Response> {
    let bearer = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned);
    let token = query
        .access_token
        .or(bearer)
        .ok_or_else(ApiError::unauthorized)?;
    let claims = server
        .tokens
        .verify_access(&token)
        .ok_or_else(ApiError::unauthorized)?;
    let user = server
        .db
        .bitwarden_user_by_id(&claims.sub)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    if user.security_stamp != claims.sstamp {
        return Err(ApiError::unauthorized());
    }
    let (seat, rx) = server
        .hub
        .join(&user.id)
        .ok_or_else(ApiError::too_many_requests)?;
    Ok(upgrade.on_upgrade(move |socket| serve(socket, rx, seat)))
}

pub(crate) async fn serve(mut socket: WebSocket, mut rx: mpsc::Receiver<Vec<u8>>, _seat: Seat) {
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    loop {
        let outgoing = tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) if frames::is_handshake(text.as_str()) => {
                    Message::Binary(frames::HANDSHAKE_REPLY.to_vec().into())
                }
                Some(Ok(Message::Ping(data))) => Message::Pong(data),
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => continue,
            },
            frame = rx.recv() => match frame {
                Some(frame) => Message::Binary(frame.into()),
                None => break,
            },
            _ = ping.tick() => Message::Binary(frames::ping().into()),
        };
        if socket.send(outgoing).await.is_err() {
            break;
        }
    }
    let _ = socket.send(Message::Close(None)).await;
}
