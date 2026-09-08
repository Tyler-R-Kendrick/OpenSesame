//! Explicit offline migration; not exposed through Host HTTP or agent tools.
use opensesame_domain::{OrganizationId, PrincipalId};
use std::path::Path;

pub async fn rebind(
    database: &Path,
    owner: PrincipalId,
    organization: OrganizationId,
    revisions: Vec<String>,
    evidence_digest: String,
    confirmed: bool,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        confirmed,
        "verify principal and organization ownership, then pass --confirm-rebind"
    );
    let metadata = std::fs::symlink_metadata(database)?;
    anyhow::ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "database must be a regular local file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // All six group/other permission bits must be zero.
        anyhow::ensure!(
            metadata.permissions().mode().trailing_zeros() >= 6,
            "database must have owner-only permissions"
        );
    }
    let selected = revisions
        .into_iter()
        .map(|value| {
            let (id, epoch) = value
                .rsplit_once('=')
                .ok_or_else(|| anyhow::anyhow!("each revision must be blob-id=epoch"))?;
            Ok((id.to_owned(), epoch.parse::<u64>()?))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let path = std::fs::canonicalize(database)?;
    let db = opensesame_storage::Db::connect_sqlite(&format!("sqlite:{}", path.display())).await?;
    let changed = db
        .rebind_legacy_sync_blobs(&owner, &organization, &selected, &evidence_digest)
        .await?;
    println!(
        "{}",
        serde_json::json!({"rebound":changed,"ciphertext_preserved":true})
    );
    Ok(())
}
