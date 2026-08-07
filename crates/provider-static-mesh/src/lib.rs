//! Static mTLS mesh adapter for tests and Headscale-oriented deployments.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum MeshError {
    #[error("{0}")]
    Msg(String),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MeshNodeIdentity {
    pub node_id: String,
    pub external_name: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MeshPeer {
    pub node_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MeshService {
    pub id: String,
    pub endpoints: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MeshEndpoint {
    pub address: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DevicePosture {
    pub healthy: bool,
}

#[async_trait]
pub trait MeshProvider: Send + Sync {
    async fn current_node(&self) -> Result<MeshNodeIdentity, MeshError>;
    async fn peers(&self) -> Result<Vec<MeshPeer>, MeshError>;
    async fn advertise(&self, service: MeshService) -> Result<(), MeshError>;
    async fn withdraw(&self, service_id: &str) -> Result<(), MeshError>;
    async fn resolve(&self, service_id: &str) -> Result<Vec<MeshEndpoint>, MeshError>;
}

#[derive(Default)]
pub struct StaticMesh {
    pub node_id: String,
    pub services: std::sync::Mutex<std::collections::HashMap<String, MeshService>>,
}

#[async_trait]
impl MeshProvider for StaticMesh {
    async fn current_node(&self) -> Result<MeshNodeIdentity, MeshError> {
        Ok(MeshNodeIdentity {
            node_id: self.node_id.clone(),
            external_name: None,
        })
    }

    async fn peers(&self) -> Result<Vec<MeshPeer>, MeshError> {
        Ok(vec![])
    }

    async fn advertise(&self, service: MeshService) -> Result<(), MeshError> {
        self.services
            .lock()
            .unwrap()
            .insert(service.id.clone(), service);
        Ok(())
    }

    async fn withdraw(&self, service_id: &str) -> Result<(), MeshError> {
        self.services.lock().unwrap().remove(service_id);
        Ok(())
    }

    async fn resolve(&self, service_id: &str) -> Result<Vec<MeshEndpoint>, MeshError> {
        Ok(self
            .services
            .lock()
            .unwrap()
            .get(service_id)
            .map(|s| {
                s.endpoints
                    .iter()
                    .cloned()
                    .map(|address| MeshEndpoint { address })
                    .collect()
            })
            .unwrap_or_default())
    }
}
