//! Experimental AAuth draft-10 adapter (feature `experimental-aauth`).
//!
//! Disabled by default. No public HTTP endpoints in this crate.

pub mod error;

#[cfg(feature = "experimental-aauth")]
pub mod adapter;

#[cfg(feature = "experimental-aauth")]
pub use adapter::*;

#[cfg(all(test, feature = "experimental-aauth"))]
mod tests;

#[cfg(test)]
mod pact {
    #[test]
    fn adapter_is_feature_gated() {
        let src = include_str!("lib.rs");
        assert!(src.contains("#[cfg(feature = \"experimental-aauth\")]"));
        assert!(src.contains("Disabled by default"));
    }
}
