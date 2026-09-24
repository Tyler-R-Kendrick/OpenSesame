use super::{CommitOutcome, SnapshotPlan, StepError};
use opensesame_storage::BackupTarget;
use serde_json::json;

#[cfg(test)]
#[path = "backup_github_tests.rs"]
mod tests;

fn object_sha(value: &serde_json::Value) -> Result<&str, StepError> {
    value
        .as_str()
        .filter(|sha| {
            matches!(sha.len(), 40 | 64)
                && sha
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(|| StepError::Retry("invalid Git object digest".into()))
}

async fn response_json(
    mut response: reqwest::Response,
) -> Result<(u16, serde_json::Value), StepError> {
    const LIMIT: usize = 1024 * 1024;
    let status = response.status().as_u16();
    if response
        .content_length()
        .is_some_and(|length| length > LIMIT as u64)
    {
        return Err(StepError::Retry("Git response exceeds limit".into()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| StepError::Retry("Git response unavailable".into()))?
    {
        if chunk.len() > LIMIT - bytes.len() {
            return Err(StepError::Retry("Git response exceeds limit".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    if !(200..300).contains(&status) {
        return Ok((status, serde_json::Value::Null));
    }
    let body = serde_json::from_slice(&bytes)
        .map_err(|_| StepError::Retry("invalid Git response".into()))?;
    Ok((status, body))
}

/// Git Data API client for atomic snapshot commits: one tree, one commit, one
/// fast-forward ref update. Injecting `api_base` keeps it fully testable.
pub struct GithubSnapshotClient {
    pub http: reqwest::Client,
    pub api_base: String,
    pub token: String,
}

impl GithubSnapshotClient {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.api_base.trim_end_matches('/'))
    }

    async fn get_json(&self, path: &str) -> Result<(u16, serde_json::Value), StepError> {
        let response = self
            .http
            .get(self.url(path))
            .timeout(std::time::Duration::from_secs(10))
            .bearer_auth(&self.token)
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "opensesame-gateway")
            .send()
            .await
            .map_err(|_| StepError::Retry("Git request unavailable".into()))?;
        response_json(response).await
    }

    async fn send_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<(u16, serde_json::Value), StepError> {
        let response = self
            .http
            .request(method, self.url(path))
            .timeout(std::time::Duration::from_secs(10))
            .bearer_auth(&self.token)
            .header("accept", "application/vnd.github+json")
            .header("user-agent", "opensesame-gateway")
            .json(body)
            .send()
            .await
            .map_err(|_| StepError::Retry("Git request unavailable".into()))?;
        response_json(response).await
    }

    pub(super) async fn commit_snapshot(
        &self,
        target: &BackupTarget,
        files: &mut SnapshotPlan,
        message: &str,
    ) -> Result<CommitOutcome, StepError> {
        let owner = &target.owner;
        let repo = &target.repo;
        let branch = &target.branch;

        // Read the current head. 404 on the ref means an empty repository or a
        // branch we have not created yet — both are first-commit cases.
        let (status, head) = self
            .get_json(&format!("/repos/{owner}/{repo}/git/ref/heads/{branch}"))
            .await?;
        let parent = match status {
            200 => Some(object_sha(&head["object"]["sha"])?.to_string()),
            404 => None,
            401 | 403 => {
                return Err(StepError::Suspend(format!(
                    "backup repository unreachable as the app installation ({status})"
                )))
            }
            other => return Err(StepError::Retry(format!("reading ref returned {other}"))),
        };

        // If the repository itself is gone, only a human can fix that.
        if parent.is_none() {
            let (repo_status, _) = self.get_json(&format!("/repos/{owner}/{repo}")).await?;
            if repo_status == 404 {
                return Err(StepError::Suspend(format!(
                    "backup repository {owner}/{repo} does not exist or the app cannot see it"
                )));
            }
        }

        let tree_sha = self.create_tree(target, files, parent.as_deref()).await?;

        // Skip empty commits: identical snapshot means nothing changed.
        if let Some(parent_sha) = &parent {
            let (status, parent_commit) = self
                .get_json(&format!("/repos/{owner}/{repo}/git/commits/{parent_sha}"))
                .await?;
            if status == 200 && parent_commit["tree"]["sha"].as_str() == Some(tree_sha.as_str()) {
                return Ok(CommitOutcome::NoChanges);
            }
        }

        let parents = parent
            .as_ref()
            .map(|sha| vec![sha.clone()])
            .unwrap_or_default();
        let (status, commit) = self
            .send_json(
                reqwest::Method::POST,
                &format!("/repos/{owner}/{repo}/git/commits"),
                &json!({"message": message, "tree": tree_sha, "parents": parents}),
            )
            .await?;
        if status != 201 {
            return Err(StepError::Retry(format!(
                "creating commit returned {status}"
            )));
        }
        let commit_sha = object_sha(&commit["sha"])?.to_string();

        // Fast-forward-only ref update is the atomic step. Losing the race
        // leaves only orphaned objects; the compensation is a rebuilt snapshot
        // against the new head on the next pass.
        let (status, _) = if parent.is_some() {
            self.send_json(
                reqwest::Method::PATCH,
                &format!("/repos/{owner}/{repo}/git/refs/heads/{branch}"),
                &json!({"sha": commit_sha, "force": false}),
            )
            .await?
        } else {
            self.send_json(
                reqwest::Method::POST,
                &format!("/repos/{owner}/{repo}/git/refs"),
                &json!({"ref": format!("refs/heads/{branch}"), "sha": commit_sha}),
            )
            .await?
        };
        match status {
            200 | 201 => Ok(CommitOutcome::Committed(commit_sha)),
            409 | 422 => Err(StepError::Retry(
                "ref moved during snapshot; rebuilding against new head".into(),
            )),
            other => Err(StepError::Retry(format!("updating ref returned {other}"))),
        }
    }
    async fn create_tree(
        &self,
        target: &BackupTarget,
        files: &mut SnapshotPlan,
        parent: Option<&str>,
    ) -> Result<String, StepError> {
        let owner = &target.owner;
        let repo = &target.repo;
        // Upload one bounded ciphertext file at a time. Only immutable object
        // references, never all ciphertext bodies, accumulate in the tree.
        let mut objects = std::collections::BTreeMap::new();
        let mut budget = super::InventoryBudget::default();
        while let Some(file) = files
            .next_file()
            .await
            .map_err(|_| StepError::Retry("snapshot page unavailable".into()))?
        {
            budget
                .reserve(&file.path, &"0".repeat(128))
                .map_err(|_| StepError::Retry("backup inventory exceeds limit".into()))?;
            let (status, blob) = self
                .send_json(
                    reqwest::Method::POST,
                    &format!("/repos/{owner}/{repo}/git/blobs"),
                    &json!({"content":file.content,"encoding":"utf-8"}),
                )
                .await?;
            if status != 201 {
                return Err(StepError::Retry(format!("creating blob returned {status}")));
            }
            let sha = object_sha(&blob["sha"])?;
            objects.insert(file.path, sha.to_owned());
        }
        let tree_entries: Vec<_> = objects
            .into_iter()
            .map(|(path, sha)| json!({"path":path,"mode":"100644","type":"blob","sha":sha}))
            .collect();
        let mut tree_request = json!({"tree":tree_entries});
        if let Some(parent_sha) = parent {
            let (status, commit) = self
                .get_json(&format!("/repos/{owner}/{repo}/git/commits/{parent_sha}"))
                .await?;
            if status != 200 {
                return Err(StepError::Retry("parent tree unavailable".into()));
            }
            let base_tree = object_sha(&commit["tree"]["sha"])?;
            // Existing historical ciphertext remains recoverable; this upload
            // never deletes another tenant's earlier backup objects.
            tree_request["base_tree"] = json!(base_tree);
        }
        let (status, tree) = self
            .send_json(
                reqwest::Method::POST,
                &format!("/repos/{owner}/{repo}/git/trees"),
                &tree_request,
            )
            .await?;
        if status != 201 {
            return Err(StepError::Retry(format!("creating tree returned {status}")));
        }
        let tree_sha = object_sha(&tree["sha"])?;

        Ok(tree_sha.to_owned())
    }
}
