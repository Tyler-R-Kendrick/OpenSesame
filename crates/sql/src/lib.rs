//! Repository database facade: `SQLite` and `PostgreSQL` runtime APIs only.
//!
//! Depend directly on the drivers so unused `SQLx` macro and `MySQL` dependencies
//! are absent from the lockfile as well as the compiled feature graph.
pub use sqlx_core::acquire::Acquire;
pub use sqlx_core::connection::{ConnectOptions, Connection};
pub use sqlx_core::error::{Error, Result};
pub use sqlx_core::executor::{Execute, Executor};
pub use sqlx_core::from_row::FromRow;
pub use sqlx_core::pool::Pool;
pub use sqlx_core::query::{query, query_with};
pub use sqlx_core::query_as::{query_as, query_as_with};
pub use sqlx_core::query_builder::QueryBuilder;
pub use sqlx_core::query_scalar::{query_scalar, query_scalar_with};
pub use sqlx_core::raw_sql::{raw_sql, RawSql};
pub use sqlx_core::row::Row;
pub use sqlx_core::transaction::Transaction;
pub use sqlx_core::{error, migrate, pool, query_builder, types};
pub use sqlx_postgres::{self as postgres, PgConnection, PgPool, Postgres};
pub use sqlx_sqlite::{self as sqlite, Sqlite, SqliteConnection, SqlitePool};
