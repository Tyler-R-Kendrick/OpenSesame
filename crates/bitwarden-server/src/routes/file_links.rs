//! Stored files and the links that open them (ADR 0148). An attachment's or a
//! Send file's ciphertext is fetched with a link whose token opens that one
//! file for an hour, so a client can hand it to its file fetcher without its
//! own bearer token.

use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use rand::Rng as _;
use serde::Deserialize;

use crate::error::{ApiError, ApiResult};
use crate::BitwardenServer;

const FILE_AUDIENCE: &str = "opensesame.bitwarden.file";
const FILE_TOKEN_SECONDS: i64 = 60 * 60;

/// A random id in Bitwarden's attachment-id shape: 32 lower-case letters and digits.
pub(crate) fn file_id() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| char::from(ALPHABET[rng.gen_range(0..ALPHABET.len())]))
        .collect()
}

/// A download link for a stored file: `{server}/files/{owner}/{id}?token=…`.
pub(crate) fn download_url(server: &BitwardenServer, owner: &str, id: &str) -> ApiResult<String> {
    let token =
        server
            .tokens
            .mint_purpose(&format!("{owner}/{id}"), FILE_AUDIENCE, FILE_TOKEN_SECONDS)?;
    Ok(format!(
        "{}/files/{owner}/{id}?token={token}",
        server.config.public_url
    ))
}

#[derive(Deserialize)]
pub struct FileToken {
    token: String,
}

/// `GET /files/{owner}/{id}?token=…`: the ciphertext of an attachment or a
/// Send's file, to whoever holds a live link for exactly it.
pub async fn download(
    State(server): State<BitwardenServer>,
    Path((owner, id)): Path<(String, String)>,
    Query(query): Query<FileToken>,
) -> ApiResult<Response> {
    if !server
        .tokens
        .verify_purpose(&query.token, FILE_AUDIENCE, &format!("{owner}/{id}"))
    {
        return Err(ApiError::not_found());
    }
    let bytes = server
        .db
        .bitwarden_blob(&id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        bytes,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_id_has_bitwardens_shape() {
        let id = file_id();
        assert_eq!(id.len(), 32);
        assert!(id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()));
    }
}
