//! GitHub repository wire parsing for [`super`], split out for the
//! module-size budget (ADR 0093).

use serde::Deserialize;
use serde_json::Value;

use super::GithubRepo;
use crate::error::{BrokerError, Result};

#[derive(Deserialize)]
struct GhRepoWire {
    name: String,
    full_name: String,
    private: bool,
    clone_url: String,
    html_url: String,
    #[serde(default)]
    default_branch: String,
}

pub(super) fn parse_github_repo(value: &Value) -> Result<GithubRepo> {
    let wire: GhRepoWire = serde_json::from_value(value.clone()).map_err(BrokerError::from)?;
    Ok(GithubRepo {
        full_name: wire.full_name,
        name: wire.name,
        private: wire.private,
        clone_url: wire.clone_url,
        html_url: wire.html_url,
        default_branch: if wire.default_branch.is_empty() {
            "main".into()
        } else {
            wire.default_branch
        },
    })
}

pub(super) fn parse_github_repo_list(value: &Value) -> Result<Vec<GithubRepo>> {
    let arr = value
        .as_array()
        .ok_or_else(|| BrokerError::Invalid("expected GitHub repo array".into()))?;
    arr.iter().map(parse_github_repo).collect()
}

pub(super) fn map_github_repo_create_error(error: BrokerError) -> BrokerError {
    let BrokerError::ExchangeFailed(detail) = &error else {
        return error;
    };
    if detail.contains("Resource not accessible by integration") {
        return BrokerError::Invalid(
            "GitHub refused to create the repository for this connection. \
             Install the tenant GitHub App on your account (All repositories; \
             Administration + Contents), then Re-authorize in Settings, \
             or connect with a personal access token that has the repo scope, \
             or pick an existing private repo from the list."
                .into(),
        );
    }
    error
}
