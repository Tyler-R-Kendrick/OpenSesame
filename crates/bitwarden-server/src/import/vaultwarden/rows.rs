//! vaultwarden's schema as it is found, and its columns as values.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::Value;
use sqlx::sqlite::{SqlitePool, SqliteRow};
use sqlx::Row as _;

use crate::import::camel_deep;

pub(super) struct Schema {
    pub tables: HashSet<String>,
    pub columns: HashMap<String, HashSet<String>>,
}

impl Schema {
    pub async fn read(pool: &SqlitePool) -> anyhow::Result<Self> {
        let tables: HashSet<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table'")
                .fetch_all(pool)
                .await?
                .into_iter()
                .collect();
        let mut columns = HashMap::new();
        for table in ["users", "ciphers"] {
            let names: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info(?)")
                .bind(table)
                .fetch_all(pool)
                .await?;
            columns.insert(table.to_owned(), names.into_iter().collect());
        }
        for required in ["users", "ciphers", "folders"] {
            anyhow::ensure!(
                tables.contains(required),
                "this is not a vaultwarden database: it has no `{required}` table"
            );
        }
        Ok(Self { tables, columns })
    }

    /// `SELECT a, NULL AS b, …`: every wanted column, `NULL` where missing.
    pub fn select(&self, table: &str, wanted: &[&str]) -> String {
        let have = &self.columns[table];
        wanted
            .iter()
            .map(|column| {
                if have.contains(*column) {
                    (*column).to_owned()
                } else {
                    format!("NULL AS {column}")
                }
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// `COUNT(*)` from `sql`, 0 when `table` is absent or the query fails.
    pub async fn count(
        &self,
        pool: &SqlitePool,
        table: &str,
        sql: &str,
        bind: Option<&str>,
    ) -> usize {
        if !self.tables.contains(table) {
            return 0;
        }
        let query = sqlx::query_scalar::<_, i64>(sql);
        let query = match bind {
            Some(value) => query.bind(value.to_owned()),
            None => query,
        };
        query
            .fetch_one(pool)
            .await
            .ok()
            .and_then(|n| usize::try_from(n).ok())
            .unwrap_or(0)
    }
}

/// vaultwarden writes `2024-01-02 03:04:05.678901`; accept RFC 3339 too.
pub(super) fn timestamp(raw: Option<String>) -> Option<DateTime<Utc>> {
    let raw = raw?;
    let raw = raw.trim();
    DateTime::parse_from_rfc3339(raw)
        .map(|at| at.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f"]
                .iter()
                .find_map(|format| NaiveDateTime::parse_from_str(raw, format).ok())
                .map(|naive| naive.and_utc())
        })
}

pub(super) fn text(row: &SqliteRow, column: &str) -> Option<String> {
    row.try_get::<Option<String>, _>(column)
        .ok()
        .flatten()
        .filter(|value| !value.is_empty())
}

pub(super) fn int(row: &SqliteRow, column: &str) -> Option<i64> {
    row.try_get::<Option<i64>, _>(column).ok().flatten()
}

pub(super) fn blob(row: &SqliteRow, column: &str) -> Vec<u8> {
    row.try_get::<Option<Vec<u8>>, _>(column)
        .ok()
        .flatten()
        .unwrap_or_default()
}

pub(super) fn json_column(row: &SqliteRow, column: &str) -> Value {
    text(row, column)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .map_or(Value::Null, camel_deep)
}
