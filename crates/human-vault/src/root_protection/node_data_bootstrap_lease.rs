//! Original CRED→BODY custody for Node's absent-destination stage/rename, with no DATA writer.
use super::{
    gate, refused, tomb_name, HeldPrivateWriterLease, NativeNodeCredentialLease,
    NativeNodeDataState, NativeNodeDataWriter, PrivateDirectory,
};
use std::{
    io,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
const MAX_NAMES: usize = 4096;
fn observed_parent(root: &Arc<PrivateDirectory>) -> io::Result<Option<Arc<PrivateDirectory>>> {
    root.validate_original()?;
    let names = root.original_bounded_directory_entries(MAX_NAMES)?;
    let result = match names.iter().find(|(name, _)| name == "vault") {
        Some((_, true)) => Some(Arc::new(root.open_child(Path::new("vault"))?)),
        Some(_) => return Err(refused()),
        None => {
            if !root.original_entry_absent(Path::new("vault"))? {
                return Err(refused());
            }
            None
        }
    };
    if root.original_bounded_directory_entries(MAX_NAMES)? != names {
        return Err(refused());
    }
    root.validate_original()?;
    Ok(result)
}
fn absent(parent: &PrivateDirectory, tomb: &str) -> io::Result<()> {
    parent.validate_original()?;
    let names = parent.original_bounded_directory_entries(MAX_NAMES)?;
    if names.iter().any(|(name, _)| name == tomb)
        || !parent.original_entry_absent(Path::new(tomb))?
        || parent.original_bounded_directory_entries(MAX_NAMES)? != names
        || !parent.original_entry_absent(Path::new(tomb))?
    {
        return Err(refused());
    }
    parent.validate_original()
}
fn observed_tomb_present(parent: &PrivateDirectory, tomb: &str) -> io::Result<bool> {
    let names = parent.original_bounded_directory_entries(MAX_NAMES)?;
    match names.iter().find(|(name, _)| name == tomb) {
        Some((_, true)) => Ok(true),
        Some(_) => Err(refused()),
        None => {
            absent(parent, tomb)?;
            Ok(false)
        }
    }
}
struct Custody {
    // Actual BODY and its captured parent drain before the retained original CRED.
    body: HeldPrivateWriterLease,
    parent: Option<Arc<PrivateDirectory>>,
    credential: Arc<NativeNodeCredentialLease>,
    logical: String,
    tomb: String,
}
impl Custody {
    fn check(&mut self) -> io::Result<()> {
        self.credential.check()?;
        self.body
            .validate_exclusive_for(&self.credential.state.locks, &self.logical)?;
        if let Some(parent) = &self.parent {
            parent.validate_original()?;
        } else {
            // Node may create the parent while holding both actual kernels. Capture it once;
            // subsequent validation uses this original object, never a replacement/current root.
            self.parent = observed_parent(&self.credential.state.root)?;
        }
        self.credential.check()
    }
    fn require_absent(&mut self) -> io::Result<()> {
        self.check()?;
        if let Some(parent) = &self.parent {
            absent(parent, &self.tomb)?;
        } else if !self
            .credential
            .state
            .root
            .original_entry_absent(Path::new("vault"))?
        {
            return Err(refused());
        }
        self.check()
    }
}
/// Opaque ordered kernel custody only. Node retains its own stage, rename and exact IO ACK proof.
/// This object has no read/publication/Root/Owner interface and cannot become a DATA writer.
pub struct NativeNodeBootstrapLease {
    held: Mutex<Option<Custody>>,
    state: Arc<NativeNodeDataState>,
    closed: AtomicBool,
}
/// Genuine same-CRED selected physical custody. No wire metadata can manufacture either variant.
pub enum NativeNodeBodyCustody {
    Writer(NativeNodeDataWriter),
    Bootstrap(NativeNodeBootstrapLease),
}
impl NativeNodeCredentialLease {
    /// Select existing writer or absent-destination lease from actual original directory census.
    /// The caller requests a tomb, never its existence, authorization or selected custody kind.
    /// # Errors
    /// Refuses unsafe/aliased/changing resources and non-contention IO; genuine BODY busy is None.
    pub fn try_capture_body_or_bootstrap(
        self: &Arc<Self>,
        tomb: &str,
    ) -> io::Result<Option<NativeNodeBodyCustody>> {
        tomb_name(tomb)?;
        let present = {
            let _operation = gate(&self.state.operations)?;
            self.check()?;
            let parent = observed_parent(&self.state.root)?;
            let present = match parent {
                Some(parent) => observed_tomb_present(&parent, tomb)?,
                None => false,
            };
            self.check()?;
            present
        };
        // Each distinct private producer rechecks its own physical condition after actual BODY
        // acquisition. A changed target refuses; it cannot fall back or promote a lease-only object.
        if present {
            self.try_capture_existing_writer(tomb)
                .map(|held| held.map(NativeNodeBodyCustody::Writer))
        } else {
            self.try_capture_bootstrap_lease(tomb)
                .map(|held| held.map(NativeNodeBodyCustody::Bootstrap))
        }
    }
    /// Try actual BODY under this original held CRED without creating the destination or parent.
    /// Issuance proves selected tomb absence; genuine kernel contention alone returns None.
    /// # Errors
    /// Refuses invalid/aliased/present destinations, changed original resources and other IO errors.
    pub fn try_capture_bootstrap_lease(
        self: &Arc<Self>,
        tomb: &str,
    ) -> io::Result<Option<NativeNodeBootstrapLease>> {
        tomb_name(tomb)?;
        let _operation = gate(&self.state.operations)?;
        self.check()?;
        let parent = observed_parent(&self.state.root)?;
        if let Some(parent) = &parent {
            absent(parent, tomb)?;
        }
        let logical = format!("opensesame:vault-body:{tomb}");
        let body = HeldPrivateWriterLease::try_exclusive(Arc::clone(&self.state.locks), &logical)?;
        self.check()?;
        let Some(body) = body else {
            if let Some(parent) = &parent {
                absent(parent, tomb)?;
            } else if observed_parent(&self.state.root)?.is_some() {
                return Err(refused());
            }
            self.check()?;
            return Ok(None);
        };
        let mut held = Custody {
            body,
            parent,
            credential: Arc::clone(self),
            logical,
            tomb: tomb.to_owned(),
        };
        held.require_absent()?;
        Ok(Some(NativeNodeBootstrapLease {
            held: Mutex::new(Some(held)),
            state: Arc::clone(&self.state),
            closed: AtomicBool::new(false),
        }))
    }
}
impl NativeNodeBootstrapLease {
    fn check_open(&self) -> io::Result<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(refused());
        }
        self.state.check()
    }
    /// Validate original key/root/locks/CRED/BODY and captured parent without requiring permanent absence.
    /// A successful Node rename changes destination existence, not this lease's kernel custody.
    /// # Errors
    /// Refuses closed/sealed/stale objects, changed ancestry/key/lease or IO errors.
    pub fn validate(&self) -> io::Result<()> {
        let _operation = gate(&self.state.operations)?;
        self.check_open()?;
        let mut held = self.held.lock().map_err(|_| refused())?;
        held.as_mut().ok_or_else(refused)?.check()?;
        self.check_open()
    }
    /// Verify actual selected destination absence before an original Node publication effect.
    /// This is physical DATA, never a caller success flag or authorization grant.
    /// # Errors
    /// Refuses present/case-aliased targets, changed original custody or IO errors.
    pub fn require_destination_absent(&self) -> io::Result<()> {
        let _operation = gate(&self.state.operations)?;
        self.check_open()?;
        let mut held = self.held.lock().map_err(|_| refused())?;
        held.as_mut().ok_or_else(refused)?.require_absent()?;
        self.check_open()
    }
    /// Signal closure and drain original native operations, releasing BODY before retained CRED.
    /// The outer Node callback must first drain its own accepted stage/rename IO before calling close.
    /// # Errors
    /// Refuses poisoned gates; resources remain owned until this original object's final drop.
    pub fn close(&self) -> io::Result<()> {
        self.closed.store(true, Ordering::Release);
        let _operation = gate(&self.state.operations)?;
        let mut held = self.held.lock().map_err(|_| refused())?;
        drop(held.take());
        Ok(())
    }
}
impl Drop for NativeNodeBootstrapLease {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
#[cfg(test)]
#[path = "node_data_bootstrap_lease_tests.rs"]
mod tests;
