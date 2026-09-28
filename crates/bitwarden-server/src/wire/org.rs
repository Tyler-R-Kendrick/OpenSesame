//! Organizations, members and collections as Bitwarden clients read them
//! (ADR 0148). Every name here is an `EncString` under the organization key,
//! every member key the organization key wrapped for that member; the server
//! passes both through.

use opensesame_storage::bitwarden::{
    member_type, BitwardenCollection, BitwardenCollectionAccess, BitwardenOrgMember,
    BitwardenOrganization, BitwardenUser,
};
use serde_json::{json, Map, Value};

use super::account::date;

/// The permission names a custom role may carry.
pub const PERMISSIONS: [&str; 12] = [
    "accessEventLogs",
    "accessImportExport",
    "accessReports",
    "createNewCollections",
    "editAnyCollection",
    "deleteAnyCollection",
    "manageGroups",
    "managePolicies",
    "manageSso",
    "manageUsers",
    "manageResetPassword",
    "manageScim",
];

/// A member's permissions object: every known name, set only for a custom
/// role and only as the role says.
#[must_use]
pub fn permissions_json(member: &BitwardenOrgMember) -> Value {
    let stored: Value = member
        .permissions
        .as_deref()
        .filter(|_| member.member_type == member_type::CUSTOM)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or(Value::Null);
    let map: Map<String, Value> = PERMISSIONS
        .iter()
        .map(|name| {
            let on = stored.get(name).and_then(Value::as_bool).unwrap_or(false);
            ((*name).to_owned(), Value::Bool(on))
        })
        .collect();
    Value::Object(map)
}

/// Keep only the known permission names from a client's permissions object.
#[must_use]
pub fn permissions_from(body: Option<&Value>) -> Option<String> {
    let body = body?.as_object()?;
    let kept: Map<String, Value> = PERMISSIONS
        .iter()
        .filter_map(|name| {
            body.get(*name)
                .and_then(Value::as_bool)
                .map(|on| ((*name).to_owned(), Value::Bool(on)))
        })
        .collect();
    Some(Value::Object(kept).to_string())
}

/// The features every organization here has: all of the password manager,
/// none of the hosted services this server does not run.
fn features() -> Map<String, Value> {
    let on = [
        "usePolicies",
        "useTotp",
        "use2fa",
        "useApi",
        "useCustomPermissions",
        "usePasswordManager",
        "usersGetPremium",
        "selfHost",
    ];
    let off = [
        "useGroups",
        "useDirectory",
        "useEvents",
        "useSso",
        "useOrganizationDomains",
        "useKeyConnector",
        "useScim",
        "useResetPassword",
        "useSecretsManager",
        "useActivateAutofillPolicy",
        "useRiskInsights",
        "useAccessIntelligence",
        "useAdminSponsoredFamilies",
    ];
    on.iter()
        .map(|k| ((*k).to_owned(), Value::Bool(true)))
        .chain(off.iter().map(|k| ((*k).to_owned(), Value::Bool(false))))
        .collect()
}

fn merge(mut base: Map<String, Value>, extra: Value) -> Value {
    if let Value::Object(extra) = extra {
        base.extend(extra);
    }
    Value::Object(base)
}

/// `ProfileOrganizationResponseModel`: one confirmed membership, as a
/// profile and a sync carry it.
#[must_use]
pub fn profile_organization(member: &BitwardenOrgMember, org: &BitwardenOrganization) -> Value {
    merge(
        features(),
        json!({
            "id": org.id,
            "identifier": null,
            "name": org.name,
            "seats": org.seats,
            "maxAutoscaleSeats": null,
            "maxCollections": null,
            "maxStorageGb": i16::MAX,
            "hasPublicAndPrivateKeys": org.public_key.is_some() && org.private_key.is_some(),
            "resetPasswordEnrolled": member.reset_password_key.is_some(),
            "ssoBound": false,
            "ssoEnabled": false,
            "keyConnectorEnabled": false,
            "keyConnectorUrl": null,
            "organizationUserId": member.id,
            "providerId": null,
            "providerName": null,
            "providerType": null,
            "familySponsorshipFriendlyName": null,
            "familySponsorshipAvailable": false,
            "planProductType": 3,
            "productTierType": 3,
            "familySponsorshipLastSyncDate": null,
            "familySponsorshipValidUntil": null,
            "familySponsorshipToDelete": null,
            "accessSecretsManager": false,
            "limitCollectionCreation": true,
            "limitCollectionDeletion": true,
            "limitItemDeletion": false,
            "allowAdminAccessToAllCollectionItems": true,
            "userIsManagedByOrganization": false,
            "userIsClaimedByOrganization": false,
            "isAdminInitiated": false,
            "permissions": permissions_json(member),
            "userId": member.user_id,
            "key": member.key,
            "status": member.status,
            "type": member.member_type,
            "enabled": true,
            "object": "profileOrganization",
        }),
    )
}

/// `OrganizationResponseModel`: the organization itself.
#[must_use]
pub fn organization_json(org: &BitwardenOrganization) -> Value {
    merge(
        features(),
        json!({
            "id": org.id,
            "identifier": null,
            "name": org.name,
            "businessName": null,
            "billingEmail": org.billing_email,
            "plan": "Enterprise",
            "planType": org.plan_type,
            "seats": org.seats,
            "maxAutoscaleSeats": null,
            "maxCollections": null,
            "maxStorageGb": i16::MAX,
            "hasPublicAndPrivateKeys": org.public_key.is_some() && org.private_key.is_some(),
            "limitCollectionCreation": true,
            "limitCollectionDeletion": true,
            "limitItemDeletion": false,
            "allowAdminAccessToAllCollectionItems": true,
            "creationDate": date(org.created_at),
            "revisionDate": date(org.revision_at),
            "object": "organization",
        }),
    )
}

/// `OrganizationKeysResponseModel`.
#[must_use]
pub fn organization_keys(org: &BitwardenOrganization) -> Value {
    json!({
        "publicKey": org.public_key,
        "privateKey": org.private_key,
        "object": "organizationKeys",
    })
}

/// `CollectionResponseModel`.
#[must_use]
pub fn collection_json(collection: &BitwardenCollection) -> Value {
    json!({
        "id": collection.id,
        "organizationId": collection.org_id,
        "name": collection.name,
        "externalId": collection.external_id,
        "type": 0,
        "defaultUserCollectionEmail": null,
        "object": "collection",
    })
}

/// `CollectionDetailsResponseModel`: a collection with how the reader
/// reaches it.
#[must_use]
pub fn collection_details(collection: &BitwardenCollection, rights: (bool, bool, bool)) -> Value {
    let (read_only, hide_passwords, manage) = rights;
    let mut out = collection_json(collection);
    out["readOnly"] = json!(read_only);
    out["hidePasswords"] = json!(hide_passwords);
    out["manage"] = json!(manage);
    out["object"] = json!("collectionDetails");
    out
}

/// A `SelectionReadOnlyResponseModel`: one member's reach into a collection.
#[must_use]
pub fn selection(id: &str, access: &BitwardenCollectionAccess) -> Value {
    json!({
        "id": id,
        "readOnly": access.read_only,
        "hidePasswords": access.hide_passwords,
        "manage": access.manage,
    })
}

/// `CollectionAccessDetailsResponseModel`: a collection with every member
/// who reaches it, and whether the reader is one of them.
#[must_use]
pub fn collection_access_details(
    collection: &BitwardenCollection,
    access: &[BitwardenCollectionAccess],
    reader: Option<&BitwardenCollectionAccess>,
) -> Value {
    let users: Vec<Value> = access
        .iter()
        .filter(|a| a.collection_id == collection.id)
        .map(|a| selection(&a.member_id, a))
        .collect();
    let mut out = collection_json(collection);
    out["readOnly"] = json!(reader.is_some_and(|r| r.read_only));
    out["hidePasswords"] = json!(reader.is_some_and(|r| r.hide_passwords));
    out["manage"] = json!(reader.is_some_and(|r| r.manage));
    out["assigned"] = json!(reader.is_some());
    out["unmanaged"] = json!(!access
        .iter()
        .any(|a| a.collection_id == collection.id && a.manage));
    out["groups"] = json!([]);
    out["users"] = json!(users);
    out["object"] = json!("collectionAccessDetails");
    out
}

/// `OrganizationUserUserDetailsResponseModel` (and, with `object` changed,
/// `OrganizationUserDetailsResponseModel`): a member as administrators list
/// them.
#[must_use]
pub fn member_details(
    member: &BitwardenOrgMember,
    user: Option<&BitwardenUser>,
    two_factor: bool,
    collections: &[Value],
) -> Value {
    json!({
        "id": member.id,
        "userId": member.user_id,
        "type": member.member_type,
        "status": member.status,
        "externalId": member.external_id,
        "accessAll": member.access_all,
        "accessSecretsManager": false,
        "permissions": permissions_json(member),
        "resetPasswordEnrolled": member.reset_password_key.is_some(),
        "hasMasterPassword": user.is_some(),
        "name": user.and_then(|u| u.name.clone()),
        "email": member.email,
        "avatarColor": null,
        "twoFactorEnabled": two_factor,
        "ssoBound": false,
        "usesKeyConnector": false,
        "collections": collections,
        "groups": [],
        "managedByOrganization": false,
        "claimedByOrganization": false,
        "object": "organizationUserUserDetails",
    })
}
