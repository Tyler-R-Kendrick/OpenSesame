//! The complete Secret Service wire surface used for discovery: `ReadAlias` and
//! three metadata properties. No session, unlock, attributes, or secret calls.

use dbus::blocking::{stdintf::org_freedesktop_dbus::Properties, Connection};
use dbus::Path;
use opensesame_connection_detect::{KeychainStore, ProbeError};
use std::time::Duration;

const DESTINATION: &str = "org.freedesktop.secrets";
const SERVICE: &str = "/org/freedesktop/secrets";
const COLLECTION: &str = "org.freedesktop.Secret.Collection";
const ITEM: &str = "org.freedesktop.Secret.Item";
const CALL_TIMEOUT: Duration = Duration::from_secs(2);

pub(super) fn enumerate_labels(
    connection: &Connection,
) -> Result<Vec<(KeychainStore, String)>, ProbeError> {
    let service = connection.with_proxy(DESTINATION, SERVICE, CALL_TIMEOUT);
    let (path,): (Path<'static>,) = service
        .method_call("org.freedesktop.Secret.Service", "ReadAlias", ("default",))
        .map_err(|e| ProbeError::Keychain(format!("secret-service collection: {e}")))?;
    // ReadAlias returns the root object path when the alias does not exist.
    if path == "/" {
        return Err(ProbeError::Keychain(
            "secret-service collection: default collection is missing".to_string(),
        ));
    }
    // Keep the destination fixed even when the service supplies an unexpected
    // object path. Object paths are typed/validated by the D-Bus decoder.
    let collection = connection.with_proxy(DESTINATION, path, CALL_TIMEOUT);
    if collection.get::<bool>(COLLECTION, "Locked").unwrap_or(true) {
        return Ok(Vec::new());
    }
    let items: Vec<Path<'static>> = collection
        .get(COLLECTION, "Items")
        .map_err(|e| ProbeError::Keychain(format!("secret-service items: {e}")))?;
    Ok(items
        .into_iter()
        .filter_map(|path| {
            connection
                .with_proxy(DESTINATION, path, CALL_TIMEOUT)
                .get::<String>(ITEM, "Label")
                .ok()
        })
        .filter(|label| !label.is_empty())
        .map(|label| (KeychainStore::SecretService, label))
        .collect())
}

#[cfg(test)]
#[path = "linux_metadata_tests.rs"]
mod tests;
