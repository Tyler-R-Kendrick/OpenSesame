//! The route table, relative to the URL a client is configured with.
//!
//! Bitwarden clients append `/api/…` and `/identity/…` to their server URL,
//! so the same table serves whether the Host mounts it at `/bitwarden` or a
//! dedicated origin mounts it at the root.

mod accounts;
mod attachments;
mod cipher_bulk;
mod ciphers;
mod credentials;
pub(crate) mod file_links;
mod folders;
mod identity;
mod meta;
mod register;
mod second_step;
mod send_access;
mod sends;
mod two_factor;

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
/// Multipart framing around an uploaded file.
const UPLOAD_OVERHEAD: usize = 64 * 1024;

pub fn router(server: BitwardenServer) -> Router {
    let max_file_bytes = server.config.max_file_bytes;
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

    let api = account_routes()
        .merge(vault_routes())
        .merge(send_routes())
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .route(
            "/ciphers/import",
            post(cipher_bulk::import).layer(DefaultBodyLimit::max(IMPORT_LIMIT)),
        )
        .merge(upload_routes(max_file_bytes));

    Router::new()
        .route("/alive", get(meta::alive))
        .route("/files/{owner}/{id}", get(file_links::download))
        .nest(
            "/identity",
            identity.layer(DefaultBodyLimit::max(BODY_LIMIT)),
        )
        .nest("/api", api)
        .with_state(server)
}

/// The account, its keys and its sign-in methods.
fn account_routes() -> Router<BitwardenServer> {
    Router::new()
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
        .route("/users/{id}/public-key", get(accounts::public_key))
        .route("/accounts/api-key", post(two_factor::api_key))
        .route("/accounts/rotate-api-key", post(two_factor::rotate_api_key))
        .route(
            "/two-factor",
            get(two_factor::list).post(two_factor::list_proved),
        )
        .route(
            "/two-factor/get-authenticator",
            post(two_factor::get_authenticator),
        )
        .route(
            "/two-factor/authenticator",
            put(two_factor::enable_authenticator)
                .post(two_factor::enable_authenticator)
                .delete(two_factor::disable),
        )
        .route(
            "/two-factor/disable",
            put(two_factor::disable).post(two_factor::disable),
        )
        .route("/two-factor/get-recover", post(two_factor::get_recover))
        .route("/two-factor/recover", post(two_factor::recover))
}

/// Folders and ciphers.
fn vault_routes() -> Router<BitwardenServer> {
    Router::new()
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
        .route("/ciphers/{id}/attachment/v2", post(attachments::announce))
        .route(
            "/ciphers/{id}/attachment/{attachment}/renew",
            get(attachments::renew),
        )
        .route(
            "/ciphers/{id}/attachment/{attachment}",
            get(attachments::describe).delete(attachments::remove),
        )
        .route(
            "/ciphers/{id}/attachment/{attachment}/delete",
            post(attachments::remove),
        )
}

/// Sends: the owner's routes and the signed-out access routes.
fn send_routes() -> Router<BitwardenServer> {
    Router::new()
        .route("/sends", get(sends::list).post(sends::create))
        .route("/sends/file/v2", post(sends::announce_file))
        .route(
            "/sends/{id}",
            get(sends::get_one).put(sends::update).delete(sends::remove),
        )
        .route("/sends/{id}/remove-password", put(sends::remove_password))
        .route("/sends/{id}/file/{file}", get(sends::renew_file))
        .route("/sends/access", post(send_access::access_with_token))
        .route("/sends/access/{access}", post(send_access::access))
        .route(
            "/sends/access/file/{file}",
            post(send_access::access_file_with_token),
        )
        .route(
            "/sends/{id}/access/file/{file}",
            post(send_access::access_file),
        )
}

/// Uploads, which carry a whole file.
fn upload_routes(max_file_bytes: usize) -> Router<BitwardenServer> {
    Router::new()
        .route("/ciphers/{id}/attachment", post(attachments::upload_legacy))
        .route(
            "/ciphers/{id}/attachment/{attachment}",
            post(attachments::upload),
        )
        .route("/sends/{id}/file/{file}", post(sends::upload_file))
        .layer(DefaultBodyLimit::max(
            max_file_bytes.saturating_add(UPLOAD_OVERHEAD),
        ))
}

/// Advance the account's revision date, returning the instant used.
pub(crate) async fn touch(server: &BitwardenServer, user_id: &str) -> ApiResult<DateTime<Utc>> {
    let now = Utc::now();
    server.db.bitwarden_touch_revision(user_id, now).await?;
    Ok(now)
}
