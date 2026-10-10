use super::{framing, wire, Path};
use base64::{engine::general_purpose::STANDARD, Engine};
use opensesame_human_vault::root_protection::node_data_state::{
    NativeNodeCredentialLease, NativeNodeDataScope, NativeNodeDataState, NativeNodeDataWriter,
    NativeNodeDeviceInventory,
};
#[cfg(unix)]
use opensesame_human_vault::root_protection::unix_private_files::PrivateDirectory;
#[cfg(windows)]
use opensesame_human_vault::root_protection::windows_private_files::PrivateDirectory;
use std::{
    io::{self, Read, Write},
    sync::Arc,
};

fn refused() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "original Node DATA transport unavailable",
    )
}
fn scope(scope: &wire::Scope) -> NativeNodeDataScope {
    match scope {
        wire::Scope::Vault => NativeNodeDataScope::Vault,
        wire::Scope::Origin => NativeNodeDataScope::Origin,
    }
}
fn bytes_reply(bytes: Option<Vec<u8>>) -> io::Result<wire::Reply> {
    if bytes
        .as_ref()
        .is_some_and(|value| value.len() > wire::MAX_DATA_BYTES)
    {
        return Err(refused());
    }
    Ok(wire::Reply::Bytes {
        base64: bytes.map(|value| STANDARD.encode(value)),
    })
}
// Decode only bounded canonical ciphertext; the genuine private producer authenticates its fixed lane.
fn ciphertext_input(value: Option<String>) -> io::Result<Option<Vec<u8>>> {
    let Some(text) = value else {
        return Ok(None);
    };
    if text.len() > 4 * wire::MAX_DATA_BYTES.div_ceil(3) {
        return Err(refused());
    }
    let bytes = STANDARD.decode(&text).map_err(|_| refused())?;
    if bytes.len() > wire::MAX_DATA_BYTES || STANDARD.encode(&bytes) != text {
        return Err(refused());
    }
    Ok(Some(bytes))
}
// Human/device-plane private child only: no connector, MCP, agent or Host API route.
// A phase ACK is DATA custody, never authentication, production principal or REAL.
struct OriginalSession {
    state: Arc<NativeNodeDataState>,
    credential: Option<Arc<NativeNodeCredentialLease>>,
    body: Option<NativeNodeDataWriter>,
    inventory: Option<NativeNodeDeviceInventory>,
}
impl OriginalSession {
    fn writer(&self) -> io::Result<&NativeNodeDataWriter> {
        self.body.as_ref().ok_or_else(refused)
    }
    fn apply(&mut self, request: wire::Request) -> io::Result<(wire::Reply, bool)> {
        if request.v != 1 {
            return Err(refused());
        }
        let reply = match request.op {
            wire::Operation::Credential {} => {
                if self.credential.is_some() || self.body.is_some() {
                    return Err(refused());
                }
                self.credential = Some(self.state.credential_writer()?);
                wire::Reply::Ack
            }
            wire::Operation::Body { tomb } => {
                if self.body.is_some() {
                    return Err(refused());
                }
                let credential = self.credential.as_ref().ok_or_else(refused)?;
                self.body = Some(credential.capture_existing_writer(&tomb)?);
                wire::Reply::Ack
            }
            operation @ (wire::Operation::PublishGeneration { .. }
            | wire::Operation::PublishDevice { .. }) => self.publish_ciphertext(operation)?,
            wire::Operation::ReadGeneration {} => {
                bytes_reply(self.writer()?.read_optional_generation_ciphertext()?)?
            }
            wire::Operation::ReadDevice { logical_key } => bytes_reply(
                self.writer()?
                    .read_optional_modern_device_ciphertext(&logical_key)?,
            )?,
            operation @ (wire::Operation::CaptureInventory {}
            | wire::Operation::ReadRetired { .. }
            | wire::Operation::InventoryTombs {}
            | wire::Operation::OriginNames {}
            | wire::Operation::InventoryClose {}) => self.apply_inventory(operation)?,
            wire::Operation::Inventory {
                scope: selected,
                maximum,
            } => {
                if maximum == 0 || maximum > 4096 {
                    return Err(refused());
                }
                wire::Reply::Inventory {
                    entries: self.writer()?.inventory(scope(&selected), maximum)?,
                }
            }
            wire::Operation::Identity { scope: selected } => wire::Reply::Identity {
                value: self.writer()?.resource_identity(scope(&selected))?,
            },
            wire::Operation::BodyClose {} => {
                if self.body.take().is_none() {
                    return Err(refused());
                }
                wire::Reply::Ack
            }
            wire::Operation::CredentialClose {} => {
                if self.body.is_some()
                    || self.inventory.is_some()
                    || self.credential.take().is_none()
                {
                    return Err(refused());
                }
                wire::Reply::Ack
            }
            wire::Operation::Validate {} => {
                if let Some(writer) = self.body.as_ref() {
                    writer.validate()?;
                }
                if let Some(inventory) = self.inventory.as_ref() {
                    inventory.validate()?;
                }
                if let Some(credential) = self.credential.as_ref() {
                    credential.validate()?;
                } else {
                    self.state.validate()?;
                }
                wire::Reply::Ack
            }
            wire::Operation::Close {} => {
                self.drain()?;
                return Ok((wire::Reply::Ack, true));
            }
        };
        Ok((reply, false))
    }
    fn publish_ciphertext(&self, operation: wire::Operation) -> io::Result<wire::Reply> {
        let reply = match operation {
            wire::Operation::PublishGeneration { expected, next } => {
                let expected = ciphertext_input(expected)?;
                let next = ciphertext_input(next)?;
                self.writer()?
                    .compare_publish_generation_ciphertext(expected.as_deref(), next.as_deref())?;
                wire::Reply::Ack
            }
            wire::Operation::PublishDevice {
                logical_key,
                expected,
                next,
            } => {
                let expected = ciphertext_input(expected)?;
                let next = ciphertext_input(next)?;
                self.writer()?.compare_publish_modern_device_ciphertext(
                    &logical_key,
                    expected.as_deref(),
                    next.as_deref(),
                )?;
                wire::Reply::Ack
            }
            _ => return Err(refused()),
        };
        Ok(reply)
    }
    fn apply_inventory(&mut self, operation: wire::Operation) -> io::Result<wire::Reply> {
        let reply = match operation {
            wire::Operation::CaptureInventory {} => {
                if self.inventory.is_some() {
                    return Err(refused());
                }
                let credential = self.credential.as_ref().ok_or_else(refused)?;
                self.inventory = Some(credential.capture_device_inventory()?);
                wire::Reply::Ack
            }
            wire::Operation::ReadRetired { tomb } => bytes_reply(
                self.inventory
                    .as_ref()
                    .ok_or_else(refused)?
                    .read_optional_retired_ciphertext(&tomb)?,
            )?,
            wire::Operation::InventoryTombs {} => wire::Reply::Names {
                values: self.inventory.as_ref().ok_or_else(refused)?.tombs()?,
            },
            wire::Operation::OriginNames {} => wire::Reply::Inventory {
                entries: self
                    .inventory
                    .as_ref()
                    .ok_or_else(refused)?
                    .origin_names()?,
            },
            wire::Operation::InventoryClose {} => {
                if self.inventory.take().is_none() {
                    return Err(refused());
                }
                wire::Reply::Ack
            }
            _ => return Err(refused()),
        };
        Ok(reply)
    }
    fn drain(&mut self) -> io::Result<()> {
        let sealed = self.state.seal();
        // Kernel BODY closes before the final retained credential reference.
        self.body.take();
        self.inventory.take();
        self.credential.take();
        sealed
    }
}
pub(super) fn run(state_path: &Path) -> io::Result<()> {
    let root = Arc::new(PrivateDirectory::open(state_path)?);
    let state = NativeNodeDataState::capture(root)?;
    serve(state, &mut io::stdin().lock(), &mut io::stdout().lock())
}
fn serve(
    state: Arc<NativeNodeDataState>,
    input: &mut impl Read,
    output: &mut impl Write,
) -> io::Result<()> {
    let mut original = OriginalSession {
        state,
        credential: None,
        body: None,
        inventory: None,
    };
    let result = (|| {
        while let Some(bytes) = framing::read(input)? {
            let request: wire::Request = serde_json::from_slice(&bytes).map_err(|_| refused())?;
            let (reply, finished) = original.apply(request)?;
            let response =
                serde_json::to_vec(&wire::Response { v: 1, reply }).map_err(|_| refused())?;
            framing::write(output, &response)?;
            if finished {
                return Ok(());
            }
        }
        Ok(())
    })();
    let drained = original.drain();
    result.and(drained)
}
#[cfg(test)]
#[path = "original_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "publication_tests.rs"]
mod publication_tests;

#[cfg(test)]
#[path = "ciphertext_fixture.rs"]
mod ciphertext_fixture;
