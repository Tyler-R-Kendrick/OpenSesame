//! Archive metadata must not consume one OS file handle per imported file.
#![cfg(unix)]
mod common;

use std::sync::Arc;

use common::vaultwarden::{fixture, write_files, ATTACHMENT, LOGIN, ORG_ITEM};
use opensesame_bitwarden_server::import::{self, vaultwarden, FileSource, WriteOptions};
use opensesame_storage::Db;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

const PER_OWNER: usize = 512;
const CIPHERTEXT: &[u8] = b"archived attachment ciphertext";

async fn archive(path: &std::path::Path) {
    let keys = fixture(path).await;
    write_files(path, &keys).await;
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(path))
        .await
        .unwrap();
    let root = path.parent().unwrap();
    for owner in [LOGIN, ORG_ITEM] {
        let directory = root.join("attachments").join(owner);
        std::fs::create_dir_all(&directory).unwrap();
        let mut tx = pool.begin().await.unwrap();
        for index in 0..PER_OWNER {
            let id = format!("{owner}-attachment-{index}");
            sqlx::query(
                "INSERT INTO attachments(id,cipher_uuid,file_name,file_size,akey)
                 SELECT ?, ?, file_name, ?, akey FROM attachments WHERE id = ?",
            )
            .bind(&id)
            .bind(owner)
            .bind(i64::try_from(CIPHERTEXT.len()).unwrap())
            .bind(ATTACHMENT)
            .execute(&mut *tx)
            .await
            .unwrap();
            std::fs::write(directory.join(id), CIPHERTEXT).unwrap();
        }
        tx.commit().await.unwrap();
    }
    pool.close().await;
}

#[tokio::test]
async fn a_large_archive_shares_one_pinned_root_across_accounts_organizations_and_sends() {
    let work = tempfile::tempdir().unwrap();
    let path = work.path().join("db.sqlite3");
    archive(&path).await;
    let source = vaultwarden::read(&path).await.unwrap();
    let files: Vec<_> = source
        .arrivals
        .iter()
        .flat_map(|arrival| {
            arrival
                .attachments
                .iter()
                .map(|file| &file.source)
                .chain(arrival.sends.iter().filter_map(|send| send.file.as_ref()))
        })
        .chain(
            source
                .organizations
                .iter()
                .flat_map(|org| org.attachments.iter().map(|file| &file.source)),
        )
        .collect();
    assert_eq!(files.len(), PER_OWNER * 2 + 2);
    let FileSource::Confined {
        directory: root, ..
    } = files[0]
    else {
        panic!("archive paths must retain the selected root");
    };
    for file in &files {
        let FileSource::Confined { directory, .. } = file else {
            panic!("archive paths must remain confined");
        };
        assert!(Arc::ptr_eq(root, directory), "one root handle per archive");
    }
    // Reader and its SQLite pool have gone away; the single retained root is
    // still sufficient for every descriptor-relative read during both writes.
    let target = Db::connect_memory().await.unwrap();
    let reports = import::write(&target, &source, WriteOptions::default())
        .await
        .unwrap();
    assert_eq!(reports[0].attachments, PER_OWNER + 1);
    assert_eq!(reports[0].sends, 2);
    let shared = import::write_shared(&target, &source, WriteOptions::default())
        .await
        .unwrap();
    assert_eq!(shared.organizations[0].attachments, PER_OWNER);
    for owner in [LOGIN, ORG_ITEM] {
        for index in [0, PER_OWNER - 1] {
            assert_eq!(
                target
                    .bitwarden_blob(&format!("{owner}-attachment-{index}"))
                    .await
                    .unwrap()
                    .unwrap(),
                CIPHERTEXT
            );
        }
    }
}
