//! Fixed authenticated outer-ciphertext publication, not vault/root authorization.
use super::super::NativeNodeDataScope;
use super::{
    binding, gate, identity, modern_name, refused, tomb_name, validate, NativeNodeDataState,
    NativeNodeDataWriter, NodeAtRestDomain, GENERATION, GLOBAL_KEY, LIMIT,
};
use std::{io, path::Path};
fn authenticate_pair(
    state: &NativeNodeDataState,
    domain: NodeAtRestDomain,
    context: &str,
    expected: Option<&[u8]>,
    next: Option<&[u8]>,
    generation: bool,
) -> io::Result<()> {
    if expected.is_none() && next.is_none() {
        return Err(refused());
    }
    for bytes in [expected, next].into_iter().flatten() {
        if bytes.len() > LIMIT || (generation && !bytes.starts_with(b"osr2.")) {
            return Err(refused());
        }
        validate(state, domain, context, bytes)?;
    }
    Ok(())
}
impl NativeNodeDataWriter {
    /// Compare and durably publish/delete only the exact original generation ciphertext.
    /// Both supplied byte snapshots are genuinely authenticated with the private captured key.
    /// The inner generation schema/authority is independently enforced by the Node consumer.
    /// # Errors
    /// Refuses legacy generation, plaintext, wrong context, byte conflicts and IO errors.
    /// An error after the namespace effect does not imply rollback.
    pub fn compare_publish_generation_ciphertext(
        &self,
        expected: Option<&[u8]>,
        next: Option<&[u8]>,
    ) -> io::Result<()> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        let tomb = self
            .logical
            .strip_prefix("opensesame:vault-body:")
            .ok_or_else(refused)?;
        tomb_name(tomb)?;
        let context = binding(tomb, &identity(&self.vault)?)?;
        authenticate_pair(
            &self.credential.state,
            NodeAtRestDomain::VaultGeneration,
            &context,
            expected,
            next,
            true,
        )?;
        self.compare_publish_under_operation(
            NativeNodeDataScope::Vault,
            Path::new(GENERATION),
            expected,
            next,
        )?;
        self.check()
    }
    /// Compare and publish/delete one modern device ciphertext in this original selected scope.
    /// No caller-chosen file path, domain, key or legacy alias is accepted.
    /// # Errors
    /// Refuses foreign scope, invalid outer ciphertext, conflicts and original IO failures.
    /// An error after the namespace effect does not imply rollback.
    pub fn compare_publish_modern_device_ciphertext(
        &self,
        logical_key: &str,
        expected: Option<&[u8]>,
        next: Option<&[u8]>,
    ) -> io::Result<()> {
        let _operation = gate(&self.credential.state.operations)?;
        self.check()?;
        let tomb = self
            .logical
            .strip_prefix("opensesame:vault-body:")
            .ok_or_else(refused)?;
        tomb_name(tomb)?;
        if logical_key != GLOBAL_KEY && !logical_key.starts_with(&format!("tomb/{tomb}/")) {
            return Err(refused());
        }
        let leaf = modern_name(logical_key)?;
        let context = binding(logical_key, &leaf)?;
        authenticate_pair(
            &self.credential.state,
            NodeAtRestDomain::DeviceRecord,
            &context,
            expected,
            next,
            false,
        )?;
        self.compare_publish_under_operation(
            NativeNodeDataScope::Origin,
            Path::new(&leaf),
            expected,
            next,
        )?;
        self.check()
    }
}
