//! A vaultwarden server's organizations and emergency contacts (ADR 0148
//! §2): every organization with its members, collections, who reaches
//! which, its ciphers and their collections, each member's own folder and
//! favourite, and its files; and every emergency contact. Nothing is
//! decrypted — the organization key stays wrapped per member, as it was.

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use opensesame_storage::bitwarden::{
    BitwardenCipher, BitwardenCollection, BitwardenCollectionAccess, BitwardenEmergencyAccess,
    BitwardenMark, BitwardenOrgArrival, BitwardenOrgMember, BitwardenOrganization,
};
use serde_json::Value;
use sqlx::sqlite::SqliteRow;

use super::files::{self, Owner};
use super::rows::{int, text, timestamp};
use super::{cipher_request, Reader, CIPHER_COLUMNS};
use crate::import::{leave, ArrivingOrganization, LeftBehind};
use crate::wire::cipher::{is_enc_string, parse_cipher_for};

const MEMBER_COLUMNS: &[&str] = &[
    "uuid",
    "user_uuid",
    "access_all",
    "akey",
    "status",
    "atype",
    "reset_password_key",
    "external_id",
];

const EMERGENCY_COLUMNS: &[&str] = &[
    "uuid",
    "grantor_uuid",
    "grantee_uuid",
    "email",
    "key_encrypted",
    "atype",
    "status",
    "wait_time_days",
    "recovery_initiated_at",
    "created_at",
    "updated_at",
];

fn enc(value: Option<String>) -> Option<String> {
    value.filter(|v| is_enc_string(v))
}

fn org_cipher(row: &SqliteRow, org: &str) -> Option<BitwardenCipher> {
    let id = text(row, "uuid")?;
    let mut request = cipher_request(row, None, false)?;
    request["organizationId"] = Value::String(org.to_owned());
    let input = parse_cipher_for(request, "", Some(org)).ok()?;
    let created = timestamp(text(row, "created_at")).unwrap_or_else(Utc::now);
    Some(BitwardenCipher {
        id,
        user_id: None,
        organization_id: Some(org.to_owned()),
        folder_id: None,
        cipher_type: input.cipher_type,
        favorite: false,
        data: input.data.to_string(),
        created_at: created,
        revision_at: timestamp(text(row, "updated_at")).unwrap_or(created),
        deleted_at: timestamp(text(row, "deleted_at")),
        archived_at: None,
    })
}

impl Reader {
    async fn rows(&self, table: &str, sql: &str, bind: &str) -> anyhow::Result<Vec<SqliteRow>> {
        if !self.schema.tables.contains(table) {
            return Ok(Vec::new());
        }
        Ok(sqlx::query(sql).bind(bind).fetch_all(&self.pool).await?)
    }

    fn select(&self, table: &str, wanted: &[&str]) -> String {
        if self
            .schema
            .columns
            .get(table)
            .is_some_and(|c| !c.is_empty())
        {
            self.schema.select(table, wanted)
        } else {
            wanted.join(", ")
        }
    }

    async fn members(
        &self,
        org: &str,
        emails: &HashMap<String, String>,
        left: &mut LeftBehind,
    ) -> anyhow::Result<Vec<BitwardenOrgMember>> {
        let sql = format!(
            "SELECT {} FROM users_organizations WHERE org_uuid = ?",
            self.select("users_organizations", MEMBER_COLUMNS)
        );
        let now = Utc::now();
        let mut out = Vec::new();
        for row in self.rows("users_organizations", &sql, org).await? {
            let user = text(&row, "user_uuid");
            let email = user.as_ref().and_then(|u| emails.get(u)).cloned();
            let (Some(id), Some(email)) = (text(&row, "uuid"), email) else {
                leave(left, "unreadable members", 1);
                continue;
            };
            out.push(BitwardenOrgMember {
                id,
                org_id: org.to_owned(),
                user_id: user,
                email,
                key: enc(text(&row, "akey")),
                status: int(&row, "status").unwrap_or(0),
                member_type: int(&row, "atype").unwrap_or(2),
                access_all: int(&row, "access_all").unwrap_or(0) != 0,
                permissions: None,
                reset_password_key: enc(text(&row, "reset_password_key")),
                external_id: text(&row, "external_id"),
                created_at: now,
                revision_at: now,
            });
        }
        Ok(out)
    }

    async fn collections(
        &self,
        org: &str,
        members: &[BitwardenOrgMember],
        left: &mut LeftBehind,
    ) -> anyhow::Result<(Vec<BitwardenCollection>, Vec<BitwardenCollectionAccess>)> {
        let now = Utc::now();
        let mut collections = Vec::new();
        let sql = format!(
            "SELECT {} FROM collections WHERE org_uuid = ?",
            self.select("collections", &["uuid", "name", "external_id"])
        );
        for row in self.rows("collections", &sql, org).await? {
            let (Some(id), Some(name)) = (text(&row, "uuid"), enc(text(&row, "name"))) else {
                leave(left, "unreadable collections", 1);
                continue;
            };
            collections.push(BitwardenCollection {
                id,
                org_id: org.to_owned(),
                name,
                external_id: text(&row, "external_id"),
                created_at: now,
                revision_at: now,
            });
        }
        let known: HashSet<&str> = collections.iter().map(|c| c.id.as_str()).collect();
        let member_of: HashMap<&str, &str> = members
            .iter()
            .filter_map(|m| m.user_id.as_deref().map(|u| (u, m.id.as_str())))
            .collect();
        let flag = |row: &SqliteRow, column: &str| int(row, column).unwrap_or(0) != 0;
        let columns = self.select(
            "users_collections",
            &[
                "user_uuid",
                "collection_uuid",
                "read_only",
                "hide_passwords",
                "manage",
            ],
        );
        let sql = format!(
            "SELECT {columns} FROM users_collections WHERE collection_uuid IN \
             (SELECT uuid FROM collections WHERE org_uuid = ?)"
        );
        let mut access = Vec::new();
        for row in self.rows("users_collections", &sql, org).await? {
            let collection = text(&row, "collection_uuid").filter(|c| known.contains(c.as_str()));
            let member = text(&row, "user_uuid").and_then(|u| member_of.get(u.as_str()).copied());
            if let (Some(collection_id), Some(member_id)) = (collection, member) {
                access.push(BitwardenCollectionAccess {
                    collection_id,
                    member_id: member_id.to_owned(),
                    read_only: flag(&row, "read_only"),
                    hide_passwords: flag(&row, "hide_passwords"),
                    manage: flag(&row, "manage"),
                });
            }
        }
        Ok((collections, access))
    }

    /// The organization's ciphers, their collections, and members' marks.
    async fn org_ciphers(
        &self,
        org: &str,
        collections: &[BitwardenCollection],
        left: &mut LeftBehind,
    ) -> anyhow::Result<(
        Vec<BitwardenCipher>,
        Vec<(String, String)>,
        Vec<(String, String, BitwardenMark)>,
    )> {
        let sql = format!(
            "SELECT {} FROM ciphers WHERE organization_uuid = ?",
            self.schema.select("ciphers", CIPHER_COLUMNS)
        );
        let mut ciphers = Vec::new();
        for row in self.rows("ciphers", &sql, org).await? {
            match org_cipher(&row, org) {
                Some(cipher) => ciphers.push(cipher),
                None => leave(left, "unreadable items", 1),
            }
        }
        let ids: HashSet<&str> = ciphers.iter().map(|c| c.id.as_str()).collect();
        let known: HashSet<&str> = collections.iter().map(|c| c.id.as_str()).collect();
        let pairs = |rows: Vec<SqliteRow>, a: &str, b: &str| -> Vec<(String, String)> {
            rows.iter()
                .filter_map(|row| Some((text(row, a)?, text(row, b)?)))
                .filter(|(cipher, _)| ids.contains(cipher.as_str()))
                .collect()
        };
        let links = pairs(
            self.rows(
                "ciphers_collections",
                "SELECT cipher_uuid, collection_uuid FROM ciphers_collections WHERE cipher_uuid IN \
                 (SELECT uuid FROM ciphers WHERE organization_uuid = ?)",
                org,
            )
            .await?,
            "cipher_uuid",
            "collection_uuid",
        )
        .into_iter()
        .filter(|(_, collection)| known.contains(collection.as_str()))
        .collect();
        let mut marks: HashMap<(String, String), BitwardenMark> = HashMap::new();
        let folders = self
            .rows(
                "folders_ciphers",
                "SELECT fc.cipher_uuid, f.user_uuid, fc.folder_uuid FROM folders_ciphers fc \
                 JOIN folders f ON f.uuid = fc.folder_uuid JOIN ciphers c ON c.uuid = fc.cipher_uuid \
                 WHERE c.organization_uuid = ?",
                org,
            )
            .await?;
        for row in &folders {
            if let (Some(cipher), Some(user)) = (text(row, "cipher_uuid"), text(row, "user_uuid")) {
                marks.entry((cipher, user)).or_default().folder_id = text(row, "folder_uuid");
            }
        }
        let favorites = self
            .rows(
                "favorites",
                "SELECT fa.cipher_uuid, fa.user_uuid FROM favorites fa \
                 JOIN ciphers c ON c.uuid = fa.cipher_uuid WHERE c.organization_uuid = ?",
                org,
            )
            .await?;
        for (cipher, user) in pairs(favorites, "cipher_uuid", "user_uuid") {
            marks.entry((cipher, user)).or_default().favorite = true;
        }
        let marks = marks
            .into_iter()
            .filter(|((cipher, _), _)| ids.contains(cipher.as_str()))
            .map(|((cipher, user), mark)| (cipher, user, mark))
            .collect();
        Ok((ciphers, links, marks))
    }

    async fn organization(
        &self,
        row: &SqliteRow,
        emails: &HashMap<String, String>,
    ) -> anyhow::Result<Option<ArrivingOrganization>> {
        let (Some(id), Some(name)) = (text(row, "uuid"), text(row, "name")) else {
            return Ok(None);
        };
        let mut left = LeftBehind::new();
        let members = self.members(&id, emails, &mut left).await?;
        let (collections, access) = self.collections(&id, &members, &mut left).await?;
        let (ciphers, links, marks) = self.org_ciphers(&id, &collections, &mut left).await?;
        let known: HashSet<String> = ciphers.iter().map(|c| c.id.clone()).collect();
        let attachments = files::attachments(
            &self.pool,
            &self.schema,
            &self.data,
            Owner::Organization(&id),
            &known,
            &mut left,
        )
        .await?;
        let now = Utc::now();
        Ok(Some(ArrivingOrganization {
            arrival: BitwardenOrgArrival {
                org: BitwardenOrganization {
                    billing_email: text(row, "billing_email").unwrap_or_default(),
                    id,
                    name,
                    plan_type: 0,
                    seats: None,
                    public_key: text(row, "public_key"),
                    private_key: enc(text(row, "private_key")),
                    created_at: now,
                    revision_at: now,
                },
                members,
                collections,
                access,
                ciphers,
                links,
                marks,
            },
            attachments,
            left_behind: left,
        }))
    }

    /// Every organization.
    pub(super) async fn organizations(&self) -> anyhow::Result<Vec<ArrivingOrganization>> {
        if !self.schema.tables.contains("organizations") {
            return Ok(Vec::new());
        }
        let emails = self.emails().await?;
        let sql = format!(
            "SELECT {} FROM organizations",
            self.select(
                "organizations",
                &["uuid", "name", "billing_email", "private_key", "public_key"]
            )
        );
        let rows = sqlx::query(&sql).fetch_all(&self.pool).await?;
        let mut out = Vec::new();
        for row in &rows {
            if let Some(org) = self.organization(row, &emails).await? {
                out.push(org);
            }
        }
        Ok(out)
    }

    async fn emails(&self) -> anyhow::Result<HashMap<String, String>> {
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT uuid, email FROM users")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .into_iter()
            .map(|(id, email)| (id, email.trim().to_ascii_lowercase()))
            .collect())
    }

    /// Every emergency contact.
    pub(super) async fn emergency(&self) -> anyhow::Result<Vec<BitwardenEmergencyAccess>> {
        if !self.schema.tables.contains("emergency_access") {
            return Ok(Vec::new());
        }
        let emails = self.emails().await?;
        let sql = format!(
            "SELECT {} FROM emergency_access",
            self.select("emergency_access", EMERGENCY_COLUMNS)
        );
        let now = Utc::now();
        let mut out = Vec::new();
        for row in sqlx::query(&sql).fetch_all(&self.pool).await? {
            let grantee = text(&row, "grantee_uuid");
            let email = grantee
                .as_ref()
                .and_then(|g| emails.get(g).cloned())
                .or_else(|| text(&row, "email").map(|e| e.trim().to_ascii_lowercase()));
            let (Some(id), Some(grantor_id), Some(email)) =
                (text(&row, "uuid"), text(&row, "grantor_uuid"), email)
            else {
                continue;
            };
            let created = timestamp(text(&row, "created_at")).unwrap_or(now);
            out.push(BitwardenEmergencyAccess {
                id,
                grantor_id,
                grantee_id: grantee,
                email,
                key_encrypted: enc(text(&row, "key_encrypted")),
                access_type: int(&row, "atype").unwrap_or(0),
                status: int(&row, "status").unwrap_or(0),
                wait_time_days: int(&row, "wait_time_days").unwrap_or(7).clamp(1, 90),
                recovery_initiated_at: timestamp(text(&row, "recovery_initiated_at")),
                created_at: created,
                revision_at: timestamp(text(&row, "updated_at")).unwrap_or(created),
            });
        }
        Ok(out)
    }
}
