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
        if service.id.is_empty()
            || service.id.contains("..")
            || service.id.contains('/')
            || service.id.contains('\\')
            || service.id.contains('\0')
        {
            return Err(MeshError::Msg("invalid service id".into()));
        }
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

#[cfg(test)]
mod pact {
    use super::*;

    #[tokio::test]
    async fn property_advertise_then_resolve_is_stable() {
        let mesh = StaticMesh {
            node_id: "n1".into(),
            services: std::sync::Mutex::default(),
        };
        mesh.advertise(MeshService {
            id: "svc".into(),
            endpoints: vec!["https://127.0.0.1:8443".into()],
        })
        .await
        .unwrap();
        let eps = mesh.resolve("svc").await.unwrap();
        assert_eq!(eps.len(), 1);
        assert_eq!(eps[0].address, "https://127.0.0.1:8443");
    }

    #[tokio::test]
    async fn adversarial_path_ids_are_refused() {
        let mesh = StaticMesh::default();
        for bad in ["", "..", "../secret", "a/b", "a\\b", "x\0y"] {
            let err = mesh
                .advertise(MeshService {
                    id: bad.into(),
                    endpoints: vec!["https://127.0.0.1:1".into()],
                })
                .await
                .expect_err(bad);
            assert!(err.to_string().contains("invalid service id"), "{bad}");
        }
        assert!(mesh.resolve("svc").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn chaos_unknown_service_resolves_empty_not_open() {
        let mesh = StaticMesh {
            node_id: "n1".into(),
            ..StaticMesh::default()
        };
        assert!(mesh.resolve("missing").await.unwrap().is_empty());
        mesh.withdraw("missing").await.unwrap();
        assert!(mesh.resolve("missing").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn contract_node_identity_has_no_secret_fields() {
        let mesh = StaticMesh {
            node_id: "n1".into(),
            ..StaticMesh::default()
        };
        let json = serde_json::to_value(mesh.current_node().await.unwrap()).unwrap();
        let blob = json.to_string();
        assert!(!blob.contains("access_token"));
        assert!(!blob.contains("private_key"));
        assert_eq!(json["node_id"], "n1");
    }
}
