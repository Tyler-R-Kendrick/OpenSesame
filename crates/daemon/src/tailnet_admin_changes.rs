//! The tailnet routes that change something (ADR 0169 §4), each a `manage`
//! bearer's call that the parent module audits.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Json,
};
use opensesame_tailnet_admin::{ops, validate::KeyRequest};
use serde::Deserialize;
use serde_json::Value;

use super::{change, Reply};
use crate::App;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Authorized {
    authorized: bool,
}

pub(super) async fn authorized(
    State(st): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Authorized>,
) -> Response {
    let action = if body.authorized {
        "device.authorize"
    } else {
        "device.deauthorize"
    };
    let target = id.clone();
    change(st, headers, action, &target, |up, store| async move {
        ops::set_authorized(&up, &store, &id, body.authorized).await?;
        Ok((Reply::Empty, None))
    })
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Name {
    name: String,
}

pub(super) async fn rename(
    State(st): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Name>,
) -> Response {
    let target = id.clone();
    change(
        st,
        headers,
        "device.rename",
        &target,
        |up, store| async move {
            ops::rename(&up, &store, &id, &body.name).await?;
            Ok((Reply::Empty, None))
        },
    )
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Tags {
    tags: Vec<String>,
}

pub(super) async fn tags(
    State(st): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Tags>,
) -> Response {
    let target = id.clone();
    change(
        st,
        headers,
        "device.tags",
        &target,
        |up, store| async move {
            ops::set_tags(&up, &store, &id, &body.tags).await?;
            Ok((Reply::Empty, None))
        },
    )
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct KeyExpiry {
    disabled: bool,
}

pub(super) async fn key_expiry(
    State(st): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<KeyExpiry>,
) -> Response {
    let target = id.clone();
    change(
        st,
        headers,
        "device.key_expiry",
        &target,
        |up, store| async move {
            ops::set_key_expiry_disabled(&up, &store, &id, body.disabled).await?;
            Ok((Reply::Empty, None))
        },
    )
    .await
}

pub(super) async fn expire(
    State(st): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let target = id.clone();
    change(
        st,
        headers,
        "device.expire",
        &target,
        |up, store| async move {
            ops::expire(&up, &store, &id).await?;
            Ok((Reply::Empty, None))
        },
    )
    .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Routes {
    enabled_routes: Vec<String>,
}

pub(super) async fn routes(
    State(st): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Routes>,
) -> Response {
    let target = id.clone();
    change(
        st,
        headers,
        "device.routes",
        &target,
        |up, store| async move {
            let view = ops::set_routes(&up, &store, &id, &body.enabled_routes).await?;
            let value = serde_json::to_value(view).unwrap_or_default();
            Ok((Reply::Json(StatusCode::OK, value), None))
        },
    )
    .await
}

pub(super) async fn delete_device(
    State(st): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let target = id.clone();
    change(
        st,
        headers,
        "device.delete",
        &target,
        |up, store| async move {
            ops::delete_device(&up, &store, &id).await?;
            Ok((Reply::Empty, None))
        },
    )
    .await
}

pub(super) async fn create_key(
    State(st): State<App>,
    headers: HeaderMap,
    Json(body): Json<KeyRequest>,
) -> Response {
    change(st, headers, "key.create", "", |up, store| async move {
        let created = ops::create_key(&up, &store, body).await?;
        let id = created
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string);
        Ok((Reply::Json(StatusCode::CREATED, created), id))
    })
    .await
}

pub(super) async fn delete_key(
    State(st): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let target = id.clone();
    change(st, headers, "key.delete", &target, |up, store| async move {
        ops::delete_key(&up, &store, &id).await?;
        Ok((Reply::Empty, None))
    })
    .await
}
