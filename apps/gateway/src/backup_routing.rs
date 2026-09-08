//! Events select their tenant from persisted domain ownership, never Host defaults.
use opensesame_domain::OrganizationId;
use opensesame_storage::{Db, OutboxEvent};
use std::collections::BTreeMap;

async fn organization(db: &Db, event: &OutboxEvent) -> anyhow::Result<Option<String>> {
    if event.payload_json.len() > 16 * 1024 {
        return Ok(None);
    }
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload_json) else {
        return Ok(None);
    };
    let declared = payload["organization_id"].as_str();
    let reference = if let Some(id) = payload["connection_id"].as_str() {
        sqlx::query_scalar::<_, String>("SELECT organization_id FROM connections WHERE id = ?")
            .bind(id)
            .fetch_optional(db.pool())
            .await?
    } else if let Some(id) = payload["vault_id"].as_str() {
        sqlx::query_scalar::<_, String>("SELECT organization_id FROM vaults WHERE id = ?")
            .bind(id)
            .fetch_optional(db.pool())
            .await?
    } else {
        None
    };
    if let (Some(declared), Some(reference)) = (declared, reference.as_deref()) {
        if declared != reference {
            return Ok(None);
        }
    }
    Ok(reference
        .as_deref()
        .or(declared)
        .and_then(|value| OrganizationId::parse(value).ok())
        .map(|id| id.to_string()))
}

pub(super) async fn group_events(
    db: &Db,
    events: Vec<OutboxEvent>,
) -> anyhow::Result<BTreeMap<String, Vec<OutboxEvent>>> {
    let mut groups: BTreeMap<String, Vec<OutboxEvent>> = BTreeMap::new();
    for event in events {
        if let Some(organization) = organization(db, &event).await? {
            groups.entry(organization).or_default().push(event);
        } else {
            db.dead_letter_outbox(
                &[event.id],
                "backup event has no verified organization; explicit resync required",
            )
            .await?;
        }
    }
    Ok(groups)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn groups_have_independent_organizations_and_unbound_events_are_not_delivered() {
        let db = Db::connect_memory().await.unwrap();
        let a = OrganizationId::new().to_string();
        let b = OrganizationId::new().to_string();
        for org in [&a, &b] {
            db.append_outbox(
                "backup.resync",
                &serde_json::json!({"organization_id":org}).to_string(),
            )
            .await
            .unwrap();
        }
        db.append_outbox("sync.blob.written", "{\"owner_id\":\"unbound\"}")
            .await
            .unwrap();
        let events = db.claim_outbox_batch(16, 60).await.unwrap();
        let groups = group_events(&db, events).await.unwrap();
        assert_eq!(groups.len(), 2);
        db.mark_outbox_published(&[groups[&a][0].id.clone()])
            .await
            .unwrap();
        assert_eq!(db.count_unpublished_outbox().await.unwrap(), 1);
        assert_eq!(groups[&b].len(), 1);
    }
}
