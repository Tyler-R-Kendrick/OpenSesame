use super::{framing, wire, Path};
#[cfg(test)]
use base64::{engine::general_purpose::STANDARD, Engine};
use opensesame_human_vault::root_protection::node_data_state::{
    NativeNodeCredentialLease, NativeNodeDataReader, NativeNodeDataScope, NativeNodeDataState,
    NativeNodeDataWriter, NativeNodeDeviceInventory,
};
#[cfg(unix)]
use opensesame_human_vault::root_protection::unix_private_files::{
    HeldPrivateWriterLease, PrivateDirectory,
};
#[cfg(windows)]
use opensesame_human_vault::root_protection::windows_private_files::{
    HeldPrivateWriterLease, PrivateDirectory,
};
use std::{
    io::{self, Read, Write},
    sync::Arc,
};

#[path = "readonly.rs"]
mod readonly;
use readonly::OriginalReadScope;
#[path = "ciphertext_codec.rs"]
mod ciphertext_codec;
use ciphertext_codec::{bytes_reply, ciphertext_input};

#[path = "custody.rs"]
mod custody;

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
// Human/device-plane private child only: no connector, MCP, agent or Host API route.
// A phase ACK is DATA custody, never authentication, production principal or REAL.
struct OriginalSession {
    state: Arc<NativeNodeDataState>,
    lease: Option<HeldPrivateWriterLease>,
    credential: Option<Arc<NativeNodeCredentialLease>>,
    body: Option<NativeNodeDataWriter>,
    reader: Option<NativeNodeDataReader>,
    inventory: Option<NativeNodeDeviceInventory>,
}
impl OriginalSession {
    fn read_scope(&self) -> io::Result<OriginalReadScope<'_>> {
        match (self.body.as_ref(), self.reader.as_ref()) {
            (Some(writer), None) => Ok(OriginalReadScope::Writer(writer)),
            (None, Some(reader)) => Ok(OriginalReadScope::Reader(reader)),
            _ => Err(refused()),
        }
    }
    fn writer(&self) -> io::Result<&NativeNodeDataWriter> {
        self.body.as_ref().ok_or_else(refused)
    }
    fn try_lease(&mut self, logical: &str, mode: wire::LeaseMode) -> io::Result<wire::Reply> {
        if self.lease.is_some()
            || self.credential.is_some()
            || self.body.is_some()
            || self.reader.is_some()
            || self.inventory.is_some()
        {
            return Err(refused());
        }
        self.lease = match mode {
            wire::LeaseMode::Shared => self.state.try_shared_lease(logical)?,
            wire::LeaseMode::Exclusive => self.state.try_exclusive_lease(logical)?,
        };
        Ok(wire::Reply::Available {
            acquired: self.lease.is_some(),
        })
    }
    fn try_credential(&mut self) -> io::Result<wire::Reply> {
        if self.lease.is_some()
            || self.credential.is_some()
            || self.body.is_some()
            || self.reader.is_some()
            || self.inventory.is_some()
        {
            return Err(refused());
        }
        self.credential = self.state.try_credential_writer()?;
        Ok(wire::Reply::Available {
            acquired: self.credential.is_some(),
        })
    }
    fn try_body(&mut self, tomb: &str) -> io::Result<wire::Reply> {
        if self.body.is_some() || self.reader.is_some() {
            return Err(refused());
        }
        let credential = self.credential.as_ref().ok_or_else(refused)?;
        self.body = credential.try_capture_existing_writer(tomb)?;
        Ok(wire::Reply::Available {
            acquired: self.body.is_some(),
        })
    }
    fn apply(&mut self, request: wire::Request) -> io::Result<(wire::Reply, bool)> {
        if request.v != 1 {
            return Err(refused());
        }
        self.validate_lease()?;
        let reply = match request.op {
            operation @ (wire::Operation::CaptureBodyReader { .. }
            | wire::Operation::BodyReaderClose {}) => self.apply_readonly(operation)?,
            wire::Operation::LeaseTry { logical, mode } => self.try_lease(&logical, mode)?,
            wire::Operation::CredentialTry {} => self.try_credential()?,
            wire::Operation::BodyTry { tomb } => self.try_body(&tomb)?,
            operation @ (wire::Operation::Lease { .. } | wire::Operation::LeaseClose {}) => {
                self.apply_generic_lease(operation)?
            }
            wire::Operation::Credential {} => self.capture_credential()?,
            wire::Operation::Body { tomb } => self.capture_body(&tomb)?,
            operation @ (wire::Operation::PublishGeneration { .. }
            | wire::Operation::PublishDevice { .. }) => self.publish_ciphertext(operation)?,
            wire::Operation::ReadGeneration {} => bytes_reply(self.read_scope()?.generation()?)?,
            wire::Operation::ReadDevice { logical_key } => {
                bytes_reply(self.read_scope()?.device(&logical_key)?)?
            }
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
                    entries: self.read_scope()?.inventory(scope(&selected), maximum)?,
                }
            }
            wire::Operation::Identity { scope: selected } => wire::Reply::Identity {
                value: self.read_scope()?.identity(scope(&selected))?,
            },
            wire::Operation::BodyClose {} => {
                if self.body.take().is_none() {
                    return Err(refused());
                }
                wire::Reply::Ack
            }
            wire::Operation::CredentialClose {} => self.close_credential()?,
            wire::Operation::Validate {} => self.validate_resources()?,
            wire::Operation::Close {} => {
                self.drain()?;
                return Ok((wire::Reply::Ack, true));
            }
        };
        self.validate_lease()?;
        Ok((reply, false))
    }
    fn apply_readonly(&mut self, operation: wire::Operation) -> io::Result<wire::Reply> {
        let reply = match operation {
            wire::Operation::CaptureBodyReader { tomb } => {
                if self.body.is_some()
                    || self.reader.is_some()
                    || self.credential.is_some()
                    || self.inventory.is_some()
                {
                    return Err(refused());
                }
                let lease = self.lease.take().ok_or_else(refused)?;
                self.reader = Some(self.state.capture_body_reader(&tomb, lease)?);
                wire::Reply::Ack
            }
            wire::Operation::BodyReaderClose {} => {
                if self.reader.take().is_none() {
                    return Err(refused());
                }
                wire::Reply::Ack
            }
            _ => return Err(refused()),
        };
        Ok(reply)
    }
    fn apply_generic_lease(&mut self, operation: wire::Operation) -> io::Result<wire::Reply> {
        let reply = match operation {
            wire::Operation::Lease { logical, mode } => {
                if self.lease.is_some()
                    || self.credential.is_some()
                    || self.body.is_some()
                    || self.reader.is_some()
                    || self.inventory.is_some()
                {
                    return Err(refused());
                }
                self.lease = Some(match mode {
                    wire::LeaseMode::Shared => self.state.shared_lease(&logical)?,
                    wire::LeaseMode::Exclusive => self.state.exclusive_lease(&logical)?,
                });
                wire::Reply::Ack
            }
            wire::Operation::LeaseClose {} => {
                if self.lease.take().is_none() {
                    return Err(refused());
                }
                wire::Reply::Ack
            }
            _ => return Err(refused()),
        };
        Ok(reply)
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
    // Generic lease custody never constructs or lends an ordered credential/body writer.
    fn validate_lease(&self) -> io::Result<()> {
        self.state.validate()?;
        if let Some(reader) = self.reader.as_ref() {
            reader.validate()?;
        }
        if let Some(lease) = self.lease.as_ref() {
            lease.validate()?;
        }
        Ok(())
    }
    fn drain(&mut self) -> io::Result<()> {
        let sealed = self.state.seal();
        self.lease.take();
        // Kernel BODY closes before the final retained credential reference.
        self.body.take();
        self.reader.take();
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
        lease: None,
        credential: None,
        body: None,
        reader: None,
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

#[cfg(test)]
#[path = "lease_tests.rs"]
mod lease_tests;
