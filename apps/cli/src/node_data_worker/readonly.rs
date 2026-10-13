//! Only genuine private native writer/readonly objects supply fixed encrypted DATA reads.
use opensesame_human_vault::root_protection::node_data_state::{
    NativeNodeDataReader, NativeNodeDataScope, NativeNodeDataWriter,
};
use std::io;
pub(super) enum OriginalReadScope<'a> {
    Writer(&'a NativeNodeDataWriter),
    Reader(&'a NativeNodeDataReader),
}
impl OriginalReadScope<'_> {
    pub(super) fn generation(&self) -> io::Result<Option<Vec<u8>>> {
        match self {
            Self::Writer(value) => value.read_optional_generation_ciphertext(),
            Self::Reader(value) => value.read_optional_generation_ciphertext(),
        }
    }
    pub(super) fn device(&self, logical: &str) -> io::Result<Option<Vec<u8>>> {
        match self {
            Self::Writer(value) => value.read_optional_modern_device_ciphertext(logical),
            Self::Reader(value) => value.read_optional_modern_device_ciphertext(logical),
        }
    }
    pub(super) fn inventory(
        &self,
        scope: NativeNodeDataScope,
        maximum: usize,
    ) -> io::Result<Vec<(String, bool)>> {
        match self {
            Self::Writer(value) => value.inventory(scope, maximum),
            Self::Reader(value) => value.inventory(scope, maximum),
        }
    }
    pub(super) fn identity(&self, scope: NativeNodeDataScope) -> io::Result<String> {
        match self {
            Self::Writer(value) => value.resource_identity(scope),
            Self::Reader(value) => value.resource_identity(scope),
        }
    }
}
