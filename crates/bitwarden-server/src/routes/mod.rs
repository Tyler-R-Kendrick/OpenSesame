//! The route table, relative to the URL a client is configured with.
//!
//! Bitwarden clients append `/api/…` and `/identity/…` to their server URL,
//! so the same table serves whether the Host mounts it at `/bitwarden` or a
//! dedicated origin mounts it at the root.

mod accounts;
mod cipher_bulk;
mod ciphers;
mod credentials;
mod folders;
mod identity;
mod meta;
mod register;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post, put};
use axum::Router;
use chrono::{DateTime, Utc};

use crate::error::ApiResult;
use crate::BitwardenServer;

/// Ordinary bodies: a cipher with a long note and history fits well inside.
const BODY_LIMIT: usize = 1024 * 1024;
/// `bw import` sends a whole vault at once.
const IMPORT_LIMIT: usize = 32 * 1024 * 1024;

pub fn router(server: BitwardenServer) -> Router {
    let identity = Router::new()
        .route("/accounts/prelogin", post(identity::prelogin))
        .route("/accounts/prelogin/password", post(identity::prelogin))
        .route("/connect/token", post(identity::token))
        .route("/accounts/register", post(register::register_legacy))
        .route(
            "/accounts/register/send-verification-email",
            post(register::send_verification_email),
        )
        .route("/accounts/register/finish", post(register::register_finish));

    let api = Router::new()
        .route("/config", get(meta::config))
        .route("/alive", get(meta::alive))
        .route("/now", get(meta::alive))
        .route("/sync", get(meta::sync))
        .route("/devices/knowndevice", get(meta::known_device))
        .route("/accounts/profile", get(accounts::profile))
        .route("/accounts/revision-date", get(accounts::revision_date))
        .route("/accounts/verify-password", post(accounts::verify_password))
        .route("/accounts/security-stamp", post(accounts::security_stamp))
        .route(
            "/accounts/keys",
            get(accounts::keys).post(accounts::set_keys),
        )
        .route("/accounts/kdf", post(accounts::change_kdf))
        .route(
            "/accounts/key-management/user-key-id",
            post(accounts::set_user_key_id).put(accounts::set_user_key_id),
        )
        .route("/accounts/password", post(accounts::change_password))
        .route("/folders", get(folders::list).post(folders::create))
        .route(
            "/folders/{id}",
            get(folders::get_one)
                .put(folders::update)
                .post(folders::update)
                .delete(folders::remove),
        )
        .route("/folders/{id}/delete", post(folders::remove))
        .route(
            "/ciphers",
            get(ciphers::list)
                .post(ciphers::create)
                .delete(cipher_bulk::delete_many),
        )
        .route("/ciphers/create", post(ciphers::create_with_collections))
        .route(
            "/ciphers/{id}",
            get(ciphers::get_one)
                .put(ciphers::update)
                .post(ciphers::update)
                .delete(ciphers::delete_one),
        )
        .route("/ciphers/{id}/details", get(ciphers::get_one))
        .route(
            "/ciphers/{id}/delete",
            put(ciphers::trash_one).post(ciphers::delete_one),
        )
        .route("/ciphers/{id}/restore", put(ciphers::restore_one))
        .route(
            "/ciphers/{id}/partial",
            put(ciphers::partial).post(ciphers::partial),
        )
        .route(
            "/ciphers/delete",
            put(cipher_bulk::trash_many).post(cipher_bulk::delete_many),
        )
        .route("/ciphers/restore", put(cipher_bulk::restore_many))
        .route(
            "/ciphers/move",
            put(cipher_bulk::move_many).post(cipher_bulk::move_many),
        )
        .route("/ciphers/purge", post(cipher_bulk::purge))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .route(
            "/ciphers/import",
            post(cipher_bulk::import).layer(DefaultBodyLimit::max(IMPORT_LIMIT)),
        );

    Router::new()
        .route("/alive", get(meta::alive))
        .nest(
            "/identity",
            identity.layer(DefaultBodyLimit::max(BODY_LIMIT)),
        )
        .nest("/api", api)
        .with_state(server)
}

/// Advance the account's revision date, returning the instant used.
pub(crate) async fn touch(server: &BitwardenServer, user_id: &str) -> ApiResult<DateTime<Utc>> {
    let now = Utc::now();
    server.db.bitwarden_touch_revision(user_id, now).await?;
    Ok(now)
}
