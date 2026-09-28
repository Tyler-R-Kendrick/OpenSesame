//! Whole accounts moved onto the Bitwarden-compatible server by the importer
//! (ADR 0148): the account, its folders and its ciphers land in one
//! transaction, or nothing does.
//!
//! A vault is encrypted under its own account's key, so an arriving account
//! is never merged into one already here. It is written only where its email
//! is free, or in place of the account at that email when the operator asks
//! for a replacement.

use super::accounts::insert_user;
use super::ciphers::insert_cipher;
use super::folders::insert_folder;
use super::{BitwardenCipher, BitwardenFolder, BitwardenUser};
use crate::Db;

/// An account as it arrives, with everything that belongs to it. Every
/// `user_id` inside must be `user.id`.
#[derive(Clone, Debug)]
pub struct BitwardenArrival {
    pub user: BitwardenUser,
    pub folders: Vec<BitwardenFolder>,
    pub ciphers: Vec<BitwardenCipher>,
}

/// What became of one arrival.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArrivalOutcome {
    /// Written; the email was free.
    Created,
    /// Written in place of the account that held the email.
    Replaced,
    /// Nothing written: the email is taken and no replacement was asked for.
    EmailTaken,
    /// Nothing written: an id it carries already belongs to another account.
    IdTaken,
}

async fn id_taken(
    tx: &mut sqlx::SqliteConnection,
    arrival: &BitwardenArrival,
) -> anyhow::Result<bool> {
    let user: Option<(String,)> = sqlx::query_as("SELECT id FROM bitwarden_users WHERE id = ?")
        .bind(&arrival.user.id)
        .fetch_optional(&mut *tx)
        .await?;
    if user.is_some() {
        return Ok(true);
    }
    for folder in &arrival.folders {
        let found: Option<(String,)> =
            sqlx::query_as("SELECT id FROM bitwarden_folders WHERE id = ?")
                .bind(&folder.id)
                .fetch_optional(&mut *tx)
                .await?;
        if found.is_some() {
            return Ok(true);
        }
    }
    for cipher in &arrival.ciphers {
        let found: Option<(String,)> =
            sqlx::query_as("SELECT id FROM bitwarden_ciphers WHERE id = ?")
                .bind(&cipher.id)
                .fetch_optional(&mut *tx)
                .await?;
        if found.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Db {
    /// Write an arriving account with its folders and ciphers. With
    /// `replace`, an account already at the same email is deleted first, with
    /// everything it owned; without it, a taken email writes nothing.
    ///
    /// # Errors
    ///
    /// Returns an error when the transaction cannot be completed; nothing is
    /// written in that case.
    pub async fn bitwarden_arrive(
        &self,
        arrival: &BitwardenArrival,
        replace: bool,
    ) -> anyhow::Result<ArrivalOutcome> {
        anyhow::ensure!(
            arrival
                .folders
                .iter()
                .map(|f| &f.user_id)
                .chain(arrival.ciphers.iter().map(|c| &c.user_id))
                .all(|owner| *owner == arrival.user.id),
            "every folder and cipher must belong to the arriving account"
        );
        let mut tx = self.pool.begin().await?;
        let existing: Option<(String,)> =
            sqlx::query_as("SELECT id FROM bitwarden_users WHERE email = ?")
                .bind(&arrival.user.email)
                .fetch_optional(&mut *tx)
                .await?;
        let outcome = match existing {
            Some(_) if !replace => return Ok(ArrivalOutcome::EmailTaken),
            Some((id,)) => {
                // Devices, folders and ciphers follow by ON DELETE CASCADE.
                sqlx::query("DELETE FROM bitwarden_users WHERE id = ?")
                    .bind(&id)
                    .execute(&mut *tx)
                    .await?;
                ArrivalOutcome::Replaced
            }
            None => ArrivalOutcome::Created,
        };
        if id_taken(&mut tx, arrival).await? {
            return Ok(ArrivalOutcome::IdTaken);
        }
        anyhow::ensure!(
            insert_user(&mut *tx, &arrival.user).await?,
            "the account's email was taken during the import"
        );
        for folder in &arrival.folders {
            insert_folder(&mut *tx, folder).await?;
        }
        for cipher in &arrival.ciphers {
            insert_cipher(&mut *tx, cipher).await?;
        }
        tx.commit().await?;
        Ok(outcome)
    }
}
