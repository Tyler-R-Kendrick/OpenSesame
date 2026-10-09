//! The sealed observation log, read (ADR 0081 §1): one page, or a tail.
//!
//! Live and replay are the same read at different cursors, and there is no
//! second pipeline. Every entry leaves as the ciphertext it was sealed as.

use std::convert::Infallible;
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{sse::Event, IntoResponse, Response, Sse},
    Json,
};
use futures::stream::Stream;
use opensesame_session_observe::Attachment;
use serde::Deserialize;
use serde_json::json;

use super::{load, stream_authority};
use crate::app_state::AppState;

/// How often the observe stream looks for new entries.
///
/// The log is a database table, not a broadcast channel, so a tail is a poll.
/// 500ms is chosen against what the stream actually carries: frames are
/// admitted at a rate the mask solver bounds (ADR 0081 §3), and the action lane
/// moves at the speed of a browser step. A tighter loop would spend queries to
/// deliver the same events.
const TAIL_POLL: Duration = Duration::from_millis(500);

/// Consecutive *idle* polls before the connection closes and the client
/// reconnects. Reset by any progress, so an active run is never cut off
/// mid-step for having been watched a while.
const TAIL_MAX_TICKS: u32 = 600;

#[derive(Debug, Deserialize)]
pub struct ObserveQuery {
    /// Last sequence number the client already has. Omit to read from the
    /// beginning — the same call the replay overlay makes.
    #[serde(default = "default_after")]
    pub after: i64,
}

const fn default_after() -> i64 {
    -1
}

/// `GET /api/v1/agent/runs/{id}/observe` — the sealed log, tailed.
///
/// Live and replay are the same read at different cursors (ADR 0081 §1): a
/// viewer passes its last position and gets the tail, the overlay passes an
/// earlier one and gets a seek. There is no second pipeline, so there is no
/// code that could be live-only and therefore no redaction that could apply on
/// one path and not the other.
///
/// Every event is relayed as the ciphertext it was sealed as. The gateway is a
/// courier here in the strict sense: it cannot read what it is forwarding.
pub async fn observe(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<ObserveQuery>,
) -> Response {
    let (_, organization_id, run) = match load(&st, &headers, &run_id, Attachment::View).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let authority = match stream_authority::StreamAuthority::capture(&st, &headers) {
        Ok(authority) => authority,
        Err(response) => return response,
    };
    let stream = tail(st, organization_id, run.id, query.after, authority);
    Sse::new(stream)
        .keep_alive(axum::response::sse::KeepAlive::default())
        .into_response()
}

/// Cursor and buffer for one open observe connection.
struct Tail {
    st: AppState,
    organization_id: String,
    run_id: String,
    cursor: i64,
    idle_ticks: u32,
    pending: std::collections::VecDeque<Event>,
    authority: stream_authority::StreamAuthority,
}

/// `GET /api/v1/agent/runs/{id}/log` — one page of the sealed log.
///
/// The same read as `observe`, without holding a connection open. Two callers
/// want this rather than a stream: the replay overlay, which seeks and pages
/// rather than follows, and anything scripted, for which an SSE stream that
/// stays open until it times out is a hang rather than a result.
///
/// Entries are relayed as the ciphertext they were sealed as, exactly as the
/// stream relays them. `sealed: true` says so rather than leaving a caller to
/// discover it.
pub async fn read_log(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
    Query(query): Query<ObserveQuery>,
) -> Response {
    let (_, organization_id, run) = match load(&st, &headers, &run_id, Attachment::View).await {
        Ok(loaded) => loaded,
        Err(response) => return response,
    };
    let entries = match st
        .db
        .read_observation_events(&organization_id, &run.id, query.after, OBSERVE_BATCH)
        .await
    {
        Ok(entries) => entries,
        Err(error) => {
            tracing::error!(%error, run_id = %run.id, "observation log could not be read");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "internal"})),
            )
                .into_response();
        }
    };
    let next = entries.last().map_or(query.after, |entry| entry.seq);
    let rendered: Vec<_> = entries
        .iter()
        .map(|entry| {
            json!({
                "seq": entry.seq,
                "lane": entry.lane,
                "of_step": entry.of_step,
                "layout_epoch": entry.layout_epoch,
                "sealed_payload": base64_std(&entry.payload),
                "recorded_at": entry.recorded_at,
            })
        })
        .collect();
    Json(json!({
        "run_id": run.id,
        "entries": rendered,
        "next_after": next,
        "run_next_seq": run.next_seq,
        "sealed": true,
        // A run the Host opened has no viewer key, so nothing was ever sealed
        // to it: this page is empty and the hook records are its observation.
        "observation": super::hook_records::observation_kind(&run),
        "secrets_returned": false,
    }))
    .into_response()
}

fn tail(
    st: AppState,
    organization_id: String,
    run_id: String,
    after: i64,
    authority: stream_authority::StreamAuthority,
) -> impl Stream<Item = Result<Event, Infallible>> {
    let seed = Tail {
        st,
        organization_id,
        run_id,
        cursor: after,
        idle_ticks: 0,
        pending: std::collections::VecDeque::new(),
        authority,
    };
    futures::stream::unfold(seed, |mut tail| async move {
        loop {
            if !tail.authority.active(&tail.st, &tail.run_id).await {
                return None;
            }
            if let Some(event) = tail.pending.pop_front() {
                return Some((Ok(event), tail));
            }
            if tail.idle_ticks >= TAIL_MAX_TICKS {
                return None;
            }
            let batch = tail
                .st
                .db
                .read_observation_events(
                    &tail.organization_id,
                    &tail.run_id,
                    tail.cursor,
                    OBSERVE_BATCH,
                )
                .await
                .unwrap_or_default();
            if batch.is_empty() {
                tail.idle_ticks += 1;
                tokio::time::sleep(TAIL_POLL).await;
                continue;
            }
            // Progress resets the idle budget: a connection that is actively
            // carrying a run should not be cut off mid-run for having been open
            // a while.
            tail.idle_ticks = 0;
            for entry in batch {
                tail.cursor = entry.seq;
                tail.pending.extend(sse_event(&entry));
            }
        }
    })
}

/// One log entry as an SSE frame.
///
/// The payload is relayed as the ciphertext it was sealed as: this route is a
/// courier in the strict sense, and there is no branch here that could read it.
fn sse_event(entry: &opensesame_storage::StoredObservationEvent) -> Option<Event> {
    Event::default()
        .json_data(json!({
            "seq": entry.seq,
            "lane": entry.lane,
            "of_step": entry.of_step,
            "layout_epoch": entry.layout_epoch,
            "sealed": base64_std(&entry.payload),
            "recorded_at": entry.recorded_at,
        }))
        .ok()
}

/// Events read per poll.
const OBSERVE_BATCH: usize = 64;

fn base64_std(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
