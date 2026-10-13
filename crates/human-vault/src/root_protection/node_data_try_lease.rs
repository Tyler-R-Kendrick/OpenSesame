//! Genuine optional kernel acquisition; availability DATA never proves owner authority.
use super::{
    gate, HeldPrivateWriterLease, NativeNodeCredentialLease, NativeNodeDataState,
    NODE_CREDENTIAL_LEASE,
};
use std::{io, sync::Arc};
impl NativeNodeDataState {
    /// Try this original state's actual shared generic kernel lease, never an ordered writer.
    /// # Errors
    /// Refuses sealed/stale state and unsafe/invalid resources; contention alone returns None.
    pub fn try_shared_lease(&self, logical: &str) -> io::Result<Option<HeldPrivateWriterLease>> {
        let _operation = gate(&self.operations)?;
        self.check()?;
        let held = HeldPrivateWriterLease::try_shared(Arc::clone(&self.locks), logical)?;
        self.check()?;
        Ok(held)
    }
    /// Try this original state's actual exclusive generic kernel lease, without DATA publication.
    /// # Errors
    /// Refuses sealed/stale state and unsafe/invalid resources; contention alone returns None.
    pub fn try_exclusive_lease(&self, logical: &str) -> io::Result<Option<HeldPrivateWriterLease>> {
        let _operation = gate(&self.operations)?;
        self.check()?;
        let held = HeldPrivateWriterLease::try_exclusive(Arc::clone(&self.locks), logical)?;
        self.check()?;
        Ok(held)
    }
    /// Try the actual CRED object; generic leases cannot substitute for this private producer.
    /// # Errors
    /// Refuses sealed/stale/unsafe state; real credential contention alone returns None.
    pub fn try_credential_writer(
        self: &Arc<Self>,
    ) -> io::Result<Option<Arc<NativeNodeCredentialLease>>> {
        let _operation = gate(&self.operations)?;
        self.check()?;
        let credential =
            HeldPrivateWriterLease::try_exclusive(Arc::clone(&self.locks), NODE_CREDENTIAL_LEASE)?;
        self.check()?;
        Ok(credential.map(|credential| {
            Arc::new(NativeNodeCredentialLease {
                state: Arc::clone(self),
                credential,
            })
        }))
    }
}
