use std::sync::Arc;

use async_trait::async_trait;
use opensesame_connection_broker::ConnectionBroker;
use opensesame_domain::OrganizationId;
use serde_json::{json, Value};

use super::{Dns01Failure, Dns01Lease, Dns01Provisioner, Dns01Record};

pub struct CloudflareDns01 {
    broker: Arc<ConnectionBroker>,
    organization: OrganizationId,
    connection_id: String,
}

pub struct CloudflareDnsLease {
    zone_id: String,
    record_id: String,
}

impl CloudflareDns01 {
    pub fn new(
        broker: Arc<ConnectionBroker>,
        organization: OrganizationId,
        connection_id: String,
    ) -> Self {
        Self {
            broker,
            organization,
            connection_id,
        }
    }

    async fn zone_id(&self, record_name: &str) -> Result<String, Dns01Failure> {
        let name = record_name
            .strip_prefix("_acme-challenge.")
            .ok_or(Dns01Failure::Rejected)?;
        let labels = name.split('.').collect::<Vec<_>>();
        for start in 0..labels.len().saturating_sub(1) {
            let candidate = labels[start..].join(".");
            let url = format!(
                "https://api.cloudflare.com/client/v4/zones?name={candidate}&status=active&per_page=1"
            );
            let response = self
                .broker
                .authorized_json(&self.organization, &self.connection_id, "GET", &url, None)
                .await
                .map_err(|_| Dns01Failure::Unavailable)?;
            if let Some(id) = response
                .get("result")
                .and_then(Value::as_array)
                .and_then(|zones| zones.first())
                .and_then(|zone| zone.get("id"))
                .and_then(Value::as_str)
                .filter(|id| cloudflare_id(id))
            {
                return Ok(id.to_owned());
            }
        }
        Err(Dns01Failure::Rejected)
    }
}

#[async_trait]
impl Dns01Provisioner for CloudflareDns01 {
    type Lease = CloudflareDnsLease;

    async fn present(&self, record: &Dns01Record) -> Result<Dns01Lease<Self::Lease>, Dns01Failure> {
        let zone_id = self.zone_id(record.name()).await?;
        let url = format!("https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records");
        let response = self
            .broker
            .authorized_json(
                &self.organization,
                &self.connection_id,
                "POST",
                &url,
                Some(json!({
                    "type": "TXT",
                    "name": record.name(),
                    "content": record.value(),
                    "ttl": 60,
                })),
            )
            .await
            .map_err(|_| Dns01Failure::Unavailable)?;
        if response.get("success").and_then(Value::as_bool) != Some(true) {
            return Err(Dns01Failure::Rejected);
        }
        let record_id = response
            .pointer("/result/id")
            .and_then(Value::as_str)
            .filter(|id| cloudflare_id(id))
            .ok_or(Dns01Failure::Rejected)?
            .to_owned();
        Ok(Dns01Lease(CloudflareDnsLease { zone_id, record_id }))
    }

    async fn cleanup(
        &self,
        Dns01Lease(lease): Dns01Lease<Self::Lease>,
    ) -> Result<(), Dns01Failure> {
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/dns_records/{}",
            lease.zone_id, lease.record_id
        );
        let response = self
            .broker
            .authorized_json(
                &self.organization,
                &self.connection_id,
                "DELETE",
                &url,
                None,
            )
            .await
            .map_err(|_| Dns01Failure::CleanupFailed)?;
        if response.get("success").and_then(Value::as_bool) == Some(true) {
            Ok(())
        } else {
            Err(Dns01Failure::CleanupFailed)
        }
    }
}

fn cloudflare_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}
