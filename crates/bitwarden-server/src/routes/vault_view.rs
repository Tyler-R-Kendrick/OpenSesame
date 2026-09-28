//! What one account sees of the vault (ADR 0148): its own ciphers, and the
//! ciphers of every organization it is a confirmed member of that its role
//! and collections reach, each with the rights it holds over it.
//!
//! Every read and write of a cipher goes through this view, so an
//! organization cipher is visible, editable or deletable by exactly the rule
//! here and nowhere else:
//!
//! * an owner or admin, a member with access to everything, or a custom role
//!   allowed to edit any collection reaches every cipher of the organization,
//!   with every right;
//! * anyone else reaches a cipher through the collections they are assigned:
//!   they may edit it if one of those collections is not read-only, see its
//!   password if one does not hide passwords, and manage it if one says so.
//!
//! Only a confirmed member — one who holds the organization key — reaches
//! anything.

use std::collections::HashMap;

use opensesame_storage::bitwarden::{
    member_status, member_type, BitwardenCipher, BitwardenCollection, BitwardenCollectionAccess,
    BitwardenMark, BitwardenOrgMember, BitwardenOrganization,
};
use serde_json::Value;

use super::attachments::attachment_json;
use crate::error::{ApiError, ApiResult};
use crate::wire::cipher::{cipher_json, CipherContext, CipherRights};
use crate::BitwardenServer;

/// What an account may do with one cipher.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Rights {
    pub edit: bool,
    pub view_password: bool,
    pub manage: bool,
    /// The cipher's collections the account can see.
    pub collection_ids: Vec<String>,
}

impl Rights {
    fn owner() -> Self {
        Self {
            edit: true,
            view_password: true,
            manage: true,
            collection_ids: Vec::new(),
        }
    }
}

/// Whether a custom role's permissions (the client's JSON) grant `name`.
pub(crate) fn permitted(member: &BitwardenOrgMember, name: &str) -> bool {
    member.member_type == member_type::CUSTOM
        && member
            .permissions
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|p| p.get(name).and_then(Value::as_bool))
            .unwrap_or(false)
}

/// One organization as a confirmed member sees it.
pub(crate) struct OrgView {
    pub member: BitwardenOrgMember,
    pub org: BitwardenOrganization,
    /// Reaches every cipher and collection.
    pub admin: bool,
    pub collections: Vec<BitwardenCollection>,
    pub my_access: HashMap<String, BitwardenCollectionAccess>,
    pub cipher_collections: HashMap<String, Vec<String>>,
}

impl OrgView {
    /// Owner or admin: manages the organization itself and its members.
    pub(crate) fn manages(&self) -> bool {
        matches!(
            self.member.member_type,
            member_type::OWNER | member_type::ADMIN
        )
    }

    pub(crate) fn is_owner(&self) -> bool {
        self.member.member_type == member_type::OWNER
    }

    /// `(read_only, hide_passwords, manage)` for a collection, if reachable.
    pub(crate) fn collection_rights(&self, collection_id: &str) -> Option<(bool, bool, bool)> {
        if self.admin {
            return self
                .collections
                .iter()
                .any(|c| c.id == collection_id)
                .then_some((false, false, true));
        }
        self.my_access
            .get(collection_id)
            .map(|a| (a.read_only, a.hide_passwords, a.manage))
    }

    /// Whether the member may put ciphers into every one of these.
    pub(crate) fn can_write_to(&self, collection_ids: &[String]) -> bool {
        collection_ids
            .iter()
            .all(|id| matches!(self.collection_rights(id), Some((false, _, _))))
    }

    fn rights_for(&self, cipher_id: &str) -> Option<Rights> {
        let linked = self
            .cipher_collections
            .get(cipher_id)
            .cloned()
            .unwrap_or_default();
        if self.admin {
            return Some(Rights {
                collection_ids: linked,
                ..Rights::owner()
            });
        }
        let reached: Vec<(String, (bool, bool, bool))> = linked
            .into_iter()
            .filter_map(|id| self.collection_rights(&id).map(|r| (id, r)))
            .collect();
        if reached.is_empty() {
            return None;
        }
        Some(Rights {
            edit: reached.iter().any(|(_, (ro, _, _))| !ro),
            view_password: reached.iter().any(|(_, (_, hide, _))| !hide),
            manage: reached.iter().any(|(_, (_, _, manage))| *manage),
            collection_ids: reached.into_iter().map(|(id, _)| id).collect(),
        })
    }
}

/// Everything one account sees.
pub(crate) struct VaultView {
    pub user_id: String,
    /// Confirmed memberships only.
    pub orgs: HashMap<String, OrgView>,
    /// The account's own ciphers and every organization cipher it reaches.
    pub ciphers: Vec<BitwardenCipher>,
    attachments: HashMap<String, Vec<Value>>,
    marks: HashMap<String, BitwardenMark>,
}

async fn org_view(
    server: &BitwardenServer,
    member: &BitwardenOrgMember,
    org: &BitwardenOrganization,
) -> ApiResult<OrgView> {
    let admin = matches!(member.member_type, member_type::OWNER | member_type::ADMIN)
        || member.access_all
        || permitted(member, "editAnyCollection");
    let my_access = server
        .db
        .bitwarden_collection_access(&org.id)
        .await?
        .into_iter()
        .filter(|a| a.member_id == member.id)
        .map(|a| (a.collection_id.clone(), a))
        .collect();
    let mut cipher_collections: HashMap<String, Vec<String>> = HashMap::new();
    for (collection, cipher) in server.db.bitwarden_collection_ciphers(&org.id).await? {
        cipher_collections
            .entry(cipher)
            .or_default()
            .push(collection);
    }
    Ok(OrgView {
        member: member.clone(),
        org: org.clone(),
        admin,
        collections: server.db.bitwarden_collections(&org.id).await?,
        my_access,
        cipher_collections,
    })
}

impl VaultView {
    pub(crate) async fn load(server: &BitwardenServer, user_id: &str) -> ApiResult<Self> {
        let mut orgs = HashMap::new();
        let mut ciphers = server.db.bitwarden_ciphers(user_id).await?;
        let mut attachments: HashMap<String, Vec<Value>> = HashMap::new();
        let mut files = server.db.bitwarden_attachments(user_id).await?;
        for (member, org) in &server.db.bitwarden_memberships(user_id).await? {
            if member.status != member_status::CONFIRMED {
                continue;
            }
            let view = org_view(server, member, org).await?;
            let reached = server.db.bitwarden_org_ciphers(&org.id).await?;
            ciphers.extend(
                reached
                    .into_iter()
                    .filter(|c| view.rights_for(&c.id).is_some()),
            );
            files.extend(server.db.bitwarden_org_attachments(&org.id).await?);
            orgs.insert(org.id.clone(), view);
        }
        for file in files.iter().filter(|f| f.uploaded) {
            attachments
                .entry(file.cipher_id.clone())
                .or_default()
                .push(attachment_json(server, file)?);
        }
        let marks = server
            .db
            .bitwarden_marks(user_id)
            .await?
            .into_iter()
            .collect();
        Ok(Self {
            user_id: user_id.to_owned(),
            orgs,
            ciphers,
            attachments,
            marks,
        })
    }

    /// The account's rights over a cipher it can see.
    pub(crate) fn rights(&self, cipher: &BitwardenCipher) -> Option<Rights> {
        match (&cipher.user_id, &cipher.organization_id) {
            (Some(owner), _) if *owner == self.user_id => Some(Rights::owner()),
            (_, Some(org)) => self.orgs.get(org)?.rights_for(&cipher.id),
            _ => None,
        }
    }

    /// The account's own folder and favourite for an organization cipher.
    pub(crate) fn mark(&self, cipher_id: &str) -> BitwardenMark {
        self.marks.get(cipher_id).cloned().unwrap_or_default()
    }

    pub(crate) fn find(&self, id: &str) -> Option<&BitwardenCipher> {
        self.ciphers.iter().find(|c| c.id == id)
    }

    /// A cipher the account can see, with its rights, or 404.
    pub(crate) fn reach(&self, id: &str) -> ApiResult<(&BitwardenCipher, Rights)> {
        let cipher = self.find(id).ok_or_else(ApiError::not_found)?;
        let rights = self.rights(cipher).ok_or_else(ApiError::not_found)?;
        Ok((cipher, rights))
    }

    /// A cipher the account may change, or 404 when it cannot see it and
    /// 400 when it can see but not edit it.
    pub(crate) fn reach_to_edit(&self, id: &str) -> ApiResult<&BitwardenCipher> {
        let (cipher, rights) = self.reach(id)?;
        if rights.edit || rights.manage {
            Ok(cipher)
        } else {
            Err(ApiError::bad_request(
                "You do not have permissions to edit this.",
            ))
        }
    }

    pub(crate) fn render(&self, cipher: &BitwardenCipher) -> Value {
        let rights = self.rights(cipher).unwrap_or_else(Rights::owner);
        let mark = self.marks.get(&cipher.id);
        let (folder_id, favorite) = if cipher.organization_id.is_some() {
            (
                mark.and_then(|m| m.folder_id.as_deref()),
                mark.is_some_and(|m| m.favorite),
            )
        } else {
            (cipher.folder_id.as_deref(), cipher.favorite)
        };
        cipher_json(
            cipher,
            &CipherContext {
                attachments: self.attachments.get(&cipher.id).map(Vec::as_slice),
                folder_id,
                favorite,
                collection_ids: &rights.collection_ids,
                rights: CipherRights {
                    edit: rights.edit,
                    view_password: rights.view_password,
                    manage: rights.manage,
                },
            },
        )
    }

    pub(crate) fn rendered(&self) -> Vec<Value> {
        self.ciphers.iter().map(|c| self.render(c)).collect()
    }
}

/// The account's confirmed membership of one organization, or 404.
pub(crate) async fn membership(
    server: &BitwardenServer,
    user_id: &str,
    org_id: &str,
) -> ApiResult<OrgView> {
    let found = server
        .db
        .bitwarden_memberships(user_id)
        .await?
        .into_iter()
        .find(|(m, _)| m.org_id == org_id && m.status == member_status::CONFIRMED);
    match found {
        Some((member, org)) => org_view(server, &member, &org).await,
        None => Err(ApiError::not_found()),
    }
}

/// A confirmed membership that manages the organization (owner or admin),
/// or whose custom role grants `permission`; 404 otherwise.
pub(crate) async fn managing(
    server: &BitwardenServer,
    user_id: &str,
    org_id: &str,
    permission: &str,
) -> ApiResult<OrgView> {
    let view = membership(server, user_id, org_id).await?;
    if view.manages() || permitted(&view.member, permission) {
        Ok(view)
    } else {
        Err(ApiError::not_found())
    }
}

/// One cipher, re-read, as the account sees it now.
pub(crate) async fn render_one(
    server: &BitwardenServer,
    user_id: &str,
    id: &str,
) -> ApiResult<Value> {
    let view = VaultView::load(server, user_id).await?;
    let (cipher, _) = view.reach(id)?;
    Ok(view.render(cipher))
}
