//! A source database/archive cannot turn file IDs into local filesystem authority.
mod common;

use common::vaultwarden::{fixture, write_files, ATTACHMENT, LOGIN, SEND_FILE, SEND_FILE_ID};
use opensesame_bitwarden_server::import::{self, vaultwarden, WriteOptions};
use opensesame_storage::Db;
use serde_json::json;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

#[tokio::test]
async fn source_database_ids_cannot_import_files_outside_the_data_folder() {
    let work = tempfile::tempdir().unwrap();
    let root = work.path().join("archive");
    std::fs::create_dir(&root).unwrap();
    let path = root.join("db.sqlite3");
    let keys = fixture(&path).await;
    write_files(&path, &keys).await;
    let outside = work.path().join("private");
    std::fs::write(&outside, b"private local data").unwrap();
    let pool = SqlitePoolOptions::new()
        .connect_with(SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    sqlx::query("UPDATE attachments SET id = ?")
        .bind(outside.to_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE sends SET data = ? WHERE uuid = ?")
        .bind(json!({"id": "../../../private", "fileName": "name"}).to_string())
        .bind(SEND_FILE)
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    let source = vaultwarden::read(&path).await.unwrap();
    let arrival = &source.arrivals[0];
    assert!(arrival.attachments.is_empty());
    assert!(arrival.sends.iter().all(|send| send.file.is_none()));
    assert_eq!(arrival.left_behind["unreadable attachments"], 1);
    assert_eq!(arrival.left_behind["unreadable Sends"], 1);
    let db = Db::connect_memory().await.unwrap();
    let report = import::write(&db, &source, WriteOptions::default())
        .await
        .unwrap();
    assert_eq!((report[0].attachments, report[0].sends), (0, 1));
    assert!(db
        .bitwarden_blob(outside.to_str().unwrap())
        .await
        .unwrap()
        .is_none());
    assert_eq!(std::fs::read(outside).unwrap(), b"private local data");
}

#[cfg(unix)]
#[tokio::test]
async fn archive_symlinks_cannot_supply_attachment_or_send_bytes() {
    use std::os::unix::fs::symlink;

    let work = tempfile::tempdir().unwrap();
    let path = work.path().join("db.sqlite3");
    let keys = fixture(&path).await;
    write_files(&path, &keys).await;
    let outside = work.path().join("private");
    std::fs::write(&outside, b"private local data").unwrap();
    let attachment = work.path().join("attachments").join(LOGIN).join(ATTACHMENT);
    let send = work.path().join("sends").join(SEND_FILE).join(SEND_FILE_ID);
    std::fs::remove_file(&attachment).unwrap();
    std::fs::remove_file(&send).unwrap();
    symlink(&outside, attachment).unwrap();
    symlink(&outside, send).unwrap();

    let source = vaultwarden::read(&path).await.unwrap();
    let db = Db::connect_memory().await.unwrap();
    let report = import::write(&db, &source, WriteOptions::default())
        .await
        .unwrap();
    assert_eq!((report[0].attachments, report[0].sends), (0, 1));
    assert_eq!(
        report[0].left_behind["attachments whose file could not be read"],
        1
    );
    assert_eq!(
        report[0].left_behind["file Sends whose file could not be read"],
        1
    );
    assert!(db.bitwarden_blob(ATTACHMENT).await.unwrap().is_none());
    assert_eq!(std::fs::read(outside).unwrap(), b"private local data");
}
