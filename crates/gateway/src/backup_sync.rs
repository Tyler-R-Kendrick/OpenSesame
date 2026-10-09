//! Backup consumes bounded inventory pages, retaining only the current page's bodies.
use super::SnapshotFile;
use anyhow::Context;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use std::collections::VecDeque;

pub struct SnapshotPlan {
    db: opensesame_storage::Db,
    organization: String,
    pending: VecDeque<SnapshotFile>,
    after: Option<(String, String, u64, String)>,
    complete: bool,
    pages: usize,
    phase: Phase,
    credential_after: String,
    revision_after: Option<(String, String, i64)>,
    credentials: usize,
    non_sync_files: usize,
}

enum Phase {
    Credentials,
    Revisions,
    Manifest,
    Sync,
}

/// Flat Git trees/connector manifests permit at most 4096 entries and 2 MiB
/// worst-case serialized metadata. Over-budget snapshots refuse publication.
#[derive(Default)]
pub(crate) struct InventoryBudget {
    entries: usize,
    bytes: usize,
}

impl InventoryBudget {
    pub(crate) fn reserve(&mut self, path: &str, digest: &str) -> anyhow::Result<()> {
        anyhow::ensure!(
            path.len() <= 1024 && digest.len() <= 128,
            "backup inventory field exceeds limit"
        );
        let cost = (path.len() + digest.len())
            .checked_mul(6)
            .and_then(|n| n.checked_add(256))
            .context("backup inventory size overflow")?;
        let next = self
            .bytes
            .checked_add(cost)
            .context("backup inventory size overflow")?;
        anyhow::ensure!(
            self.entries < 4096 && next <= 2 * 1024 * 1024 - 16384,
            "backup inventory exceeds limit"
        );
        self.entries += 1;
        self.bytes = next;
        Ok(())
    }
}

impl SnapshotPlan {
    pub(super) fn new(db: opensesame_storage::Db, organization: String) -> Self {
        Self {
            db,
            organization,
            pending: VecDeque::from([SnapshotFile {
                path: "README.md".into(),
                content: "# OpenSesame backup store\n\nCiphertext snapshots written by the OpenSesame backup actor (ADR 0039). Every file is sealed; none of it can be read without keys that never enter this repository.\n".into(),
            }]),
            after: None,
            complete: false,
            pages: 0,
            phase: Phase::Credentials,
            credential_after: String::new(),
            revision_after: None,
            credentials: 0,
            non_sync_files: 1,
        }
    }

    pub async fn next_file(&mut self) -> anyhow::Result<Option<SnapshotFile>> {
        loop {
            if let Some(file) = self.pending.pop_front() {
                return Ok(Some(file));
            }
            match self.phase {
                Phase::Credentials => self.credentials_page().await?,
                Phase::Revisions => self.revisions_page().await?,
                Phase::Manifest => {
                    self.phase = Phase::Sync;
                    return Ok(Some(SnapshotFile {
                        path: "manifest.json".into(),
                        content: serde_json::to_string_pretty(&serde_json::json!({
                            "schema":1,"connections":self.credentials,
                            "non_sync_files":self.non_sync_files,"sync_format":2,
                        }))?,
                    }));
                }
                Phase::Sync => return self.next_sync_file().await,
            }
        }
    }

    fn count_page(&mut self) -> anyhow::Result<()> {
        anyhow::ensure!(self.pages < 4096, "backup page count exceeded");
        self.pages += 1;
        Ok(())
    }

    async fn credentials_page(&mut self) -> anyhow::Result<()> {
        self.count_page()?;
        let (page, more) = self
            .db
            .backup_credentials_page(&self.organization, &self.credential_after)
            .await?;
        if !more {
            self.phase = Phase::Revisions;
        }
        for row in page {
            self.credential_after.clone_from(&row.connection_id);
            self.credentials += 1;
            self.non_sync_files += 1;
            let expires = row
                .expires_at
                .map(|value| {
                    chrono::DateTime::parse_from_rfc3339(&value)
                        .map(|time| time.with_timezone(&chrono::Utc))
                })
                .transpose()?;
            self.pending.push_back(SnapshotFile {
                path: format!(
                    "connections/{}.json",
                    URL_SAFE_NO_PAD.encode(&row.connection_id)
                ),
                content: serde_json::to_string_pretty(&serde_json::json!({
                    "connection_id":row.connection_id,"version":row.version,
                    "sealed":{"ciphertext_b64":STANDARD.encode(row.ciphertext),
                        "nonce_b64":STANDARD.encode(row.nonce),"aad_digest":row.aad_digest},
                    "token_type":row.token_type,"expires_at":expires,"refreshable":row.refreshable,
                }))?,
            });
        }
        Ok(())
    }

    async fn revisions_page(&mut self) -> anyhow::Result<()> {
        self.count_page()?;
        let (page, more) = self
            .db
            .backup_revisions_page(&self.organization, self.revision_after.as_ref())
            .await?;
        if !more {
            self.phase = Phase::Manifest;
        }
        for row in page {
            self.revision_after = Some((row.vault_id.clone(), row.item_id.clone(), row.revision));
            self.non_sync_files += 1;
            self.pending.push_back(SnapshotFile {
                path: format!("vault/{}/{}/{}.json",URL_SAFE_NO_PAD.encode(&row.vault_id),URL_SAFE_NO_PAD.encode(&row.item_id),row.revision),
                content: serde_json::to_string_pretty(&serde_json::json!({
                    "vault_id":row.vault_id,"item_id":row.item_id,"revision":row.revision,
                    "ciphertext_b64":STANDARD.encode(row.ciphertext),"wrapping":row.wrapping_json,"ad_digest":row.ad_digest,
                }))?,
            });
        }
        Ok(())
    }

    async fn next_sync_file(&mut self) -> anyhow::Result<Option<SnapshotFile>> {
        if let Some(file) = self.pending.pop_front() {
            return Ok(Some(file));
        }
        if self.complete {
            return Ok(None);
        }
        self.count_page()?;
        let (page, more) = self
            .db
            .list_sync_backup_page_scoped(&self.organization, self.after.as_ref())
            .await?;
        self.after = page.last().map(|(org, owner, entry)| {
            (
                org.clone(),
                owner.clone(),
                entry.sequence,
                entry.blob.id.clone(),
            )
        });
        self.complete = !more;
        anyhow::ensure!(!more || self.after.is_some(), "missing backup cursor");
        for (organization, owner, entry) in page {
            let blob = entry.blob;
            let owner_path = URL_SAFE_NO_PAD.encode(owner.as_bytes());
            let path = if organization.is_empty() {
                owner_path
            } else {
                format!(
                    "{}/{}",
                    URL_SAFE_NO_PAD.encode(organization.as_bytes()),
                    owner_path
                )
            };
            self.pending.push_back(SnapshotFile {
                path: format!(
                    "sync/{}/{}.json",
                    path,
                    URL_SAFE_NO_PAD.encode(blob.id.as_bytes())
                ),
                content: serde_json::to_string_pretty(&serde_json::json!({
                    "organization_id":organization,"owner_id":owner,"blob_id":blob.id,
                    "epoch":blob.epoch,"ciphertext_b64":STANDARD.encode(blob.ciphertext),
                }))?,
            });
        }
        Ok(self.pending.pop_front())
    }
}

#[cfg(test)]
mod inventory_tests {
    use super::{InventoryBudget, SnapshotPlan};

    #[test]
    fn count_and_escaped_metadata_refuse_before_budget_growth() {
        let mut count = InventoryBudget::default();
        for _ in 0..4096 {
            count.reserve("p", "d").unwrap();
        }
        let before = (count.entries, count.bytes);
        assert!(count.reserve("p", "d").is_err());
        assert_eq!((count.entries, count.bytes), before);
        let mut bytes = InventoryBudget::default();
        while bytes.reserve(&"x".repeat(1024), &"d".repeat(128)).is_ok() {}
        let before = (bytes.entries, bytes.bytes);
        assert!(before.0 < 4096);
        assert!(bytes.reserve(&"x".repeat(1024), &"d".repeat(128)).is_err());
        assert_eq!((bytes.entries, bytes.bytes), before);
        assert!(bytes.reserve(&"x".repeat(1025), "d").is_err());
    }

    #[tokio::test]
    async fn phased_inventory_continues_across_empty_credentials_and_revision_pages() {
        let db = opensesame_storage::Db::connect_memory().await.unwrap();
        sqlx::query("INSERT INTO organizations(id,name,created_at) VALUES ('org','test','t')")
            .execute(db.pool())
            .await
            .unwrap();
        sqlx::query("INSERT INTO vaults(id,organization_id,created_at) VALUES ('vault','org','t')")
            .execute(db.pool())
            .await
            .unwrap();
        for revision in 0..33 {
            db.insert_encrypted_item("vault", "item", revision, &[1, 2, 3], "{}", "digest")
                .await
                .unwrap();
        }
        let mut plan = SnapshotPlan::new(db, "org".into());
        assert_eq!(plan.next_file().await.unwrap().unwrap().path, "README.md");
        for revision in 0..33 {
            let file = plan.next_file().await.unwrap().unwrap();
            assert!(file.path.starts_with("vault/"));
            let body: serde_json::Value = serde_json::from_str(&file.content).unwrap();
            assert_eq!(body["revision"], revision);
            assert_eq!(body["ciphertext_b64"], "AQID");
        }
        let manifest = plan.next_file().await.unwrap().unwrap();
        assert_eq!(manifest.path, "manifest.json");
        let body: serde_json::Value = serde_json::from_str(&manifest.content).unwrap();
        assert_eq!(body["connections"], 0);
        assert_eq!(body["non_sync_files"], 34);
        assert!(plan.next_file().await.unwrap().is_none());
    }
}
