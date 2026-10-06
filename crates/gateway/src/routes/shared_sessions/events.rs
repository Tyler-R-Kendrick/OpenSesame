//! Live shared-session delivery revalidates closure and seats for every frame.
use super::{announce, not_found, standing, Presence};
use crate::{
    app_state::AppState,
    session_channel::{Delivery, Recipient, SessionChannel, SessionEvent},
    shared_session_fence::Reach,
};
use axum::{
    extract::{Path, State},
    response::{sse, IntoResponse, Response, Sse},
};
use chrono::Utc;
use opensesame_domain::{PrincipalId, SessionId, SessionMode};

async fn current_recipient(
    st: &AppState,
    organization: &str,
    session_id: SessionId,
    principal: PrincipalId,
) -> Option<Recipient> {
    let session = st.db.session(organization, session_id).await.ok()??;
    let now = Utc::now();
    let reach = Reach::of(&st.db, &session, principal, now).await;
    if !reach.may_see_session() {
        return None;
    }
    let mode = match reach {
        Reach::Participant => Some(SessionMode::Participant),
        Reach::Observer => Some(SessionMode::Observer),
        Reach::Operator | Reach::None => None,
    };
    let grants = st
        .db
        .active_grants_for(session_id, principal, now)
        .await
        .ok()?;
    Some(Recipient {
        principal_id: principal,
        is_operator: reach.is_operator(),
        mode,
        grants,
    })
}

/// `GET /api/v1/shared-sessions/{id}/events` — the session's live channel.
///
/// Server-sent events, one direction only. That is the security decision in
/// this handler rather than an implementation convenience: ADR 0079 §6 says an
/// inbound message is a request like any other and never evidence its sender
/// is allowed, and the cheapest way to hold that rule is to have no inbound
/// frame path at all. Everything a participant *does* goes through the
/// authenticated routes above, where the fence already runs.
///
/// Standing is re-read from the store on every event rather than captured at
/// subscribe time. A subscription is not a permission: a participant whose
/// grant is withdrawn or lapses mid-stream stops receiving on the next event,
/// not at their next reconnect.
pub async fn events(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let (principal, session, reach) = match standing(&st, &headers, &id).await {
        Ok(found) => found,
        Err(resp) => return resp,
    };
    if !reach.may_see_session() {
        return not_found();
    }
    let seated = match reach {
        Reach::Participant => Some(SessionMode::Participant),
        Reach::Observer => Some(SessionMode::Observer),
        Reach::Operator | Reach::None => None,
    };

    let receiver = {
        let mut channels = st.session_channels.lock().unwrap();
        // Sessions with no reader are dropped when their last one leaves, so
        // the map holds live channels rather than a row per session ever
        // opened.
        channels.retain(|_, channel| !channel.is_idle());
        channels
            .entry(session.id)
            .or_insert_with(SessionChannel::new)
            .subscribe()
    };

    let session_id = session.id;
    announce(
        &st,
        session_id,
        SessionEvent::ParticipantJoined {
            principal_id: principal,
            // The seat, not a role. The operator used to be announced as
            // `write`, which said the person running the session writes the
            // vault through it; they run it, and they are seated as a
            // participant only if somebody seated them.
            mode: seated.unwrap_or(SessionMode::Participant),
        },
    );
    let presence = Presence {
        state: st.clone(),
        session_id,
        principal_id: principal,
    };

    // `unfold` rather than a generator macro: the loop's state is exactly the
    // receiver, and the per-event standing read is an ordinary await inside it.
    let stream = futures::stream::unfold(
        (receiver, st.clone(), presence, session.organization_id),
        move |(mut receiver, st, presence, organization_id)| async move {
            loop {
                let notification = receiver.recv().await;
                // A subscription never preserves a seat. Closure, removal and
                // role changes take effect before the next frame, including
                // lag notices. Storage failure ends delivery rather than
                // falling back to the standing held when the stream opened.
                let recipient =
                    current_recipient(&st, &organization_id, session_id, principal).await?;
                let event = match notification {
                    Ok(event) => event,
                    // A reader that fell behind is told how far and keeps its
                    // place. It never grows the buffer for anybody else.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                        let notice = sse::Event::default()
                            .event("lagged")
                            .data(missed.to_string());
                        return Some((
                            Ok::<_, std::convert::Infallible>(notice),
                            (receiver, st, presence, organization_id),
                        ));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
                };

                let now = Utc::now();
                if !Delivery::for_recipient(&event, &recipient, now) {
                    continue;
                }
                match serde_json::to_string(&event) {
                    Ok(payload) => {
                        let frame = sse::Event::default().data(payload);
                        return Some((Ok(frame), (receiver, st, presence, organization_id)));
                    }
                    Err(error) => {
                        tracing::warn!(%error, "session event would not serialize");
                    }
                }
            }
        },
    );

    Sse::new(stream)
        .keep_alive(sse::KeepAlive::default())
        .into_response()
}
