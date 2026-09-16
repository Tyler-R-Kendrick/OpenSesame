//! A grant's ancestry, and the materialized path that stores it.
//!
//! Split from `mod.rs` to stay inside the 400-line module budget (ADR 0093).
//! The reasoning that matters lives on the items themselves; see the module
//! docs in `mod.rs` for why the fence points this direction at all.

use super::{MAX_FENCE_DEPTH, SEPARATOR, SUBTREE_UPPER};
use std::fmt;

/// Why a lineage could not be built.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LineageError {
    /// An id was empty, or carried a character a materialized path cannot
    /// delimit or a `LIKE` prefix cannot safely carry.
    UnusableId(String),
    /// The chain is longer than [`MAX_FENCE_DEPTH`].
    TooDeep(usize),
    /// A path was not of the `/a/b/` shape, or was empty.
    MalformedPath(String),
    /// The same id appeared twice; a cycle would make the fence unbounded.
    Cycle(String),
}

impl fmt::Display for LineageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnusableId(id) => write!(f, "grant id `{id}` cannot appear in a fence path"),
            Self::TooDeep(depth) => {
                write!(f, "delegation chain of {depth} exceeds {MAX_FENCE_DEPTH}")
            }
            Self::MalformedPath(path) => write!(f, "`{path}` is not a fence path"),
            Self::Cycle(id) => write!(f, "grant id `{id}` appears twice in its own lineage"),
        }
    }
}

impl std::error::Error for LineageError {}

/// Whether an id may appear in a materialized path.
///
/// Paths are compared by range in the store, so an id carrying the separator
/// could forge an ancestor. Pattern metacharacters (`%`, `_`, `\`) are
/// excluded too, so that a caller who reaches for `LIKE` instead of
/// [`Lineage::subtree_bounds`] cannot widen a prefix into a sibling's subtree
/// either. The allowlist is ASCII alphanumerics, `-` and `:` — exactly the
/// shape of a prefixed grant id (`grant:<uuid>`), which is how the `grants`
/// table spells its primary key.
#[must_use]
pub fn is_fence_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == ':')
}

/// One grant's ancestry, root first and itself last.
///
/// Built once when the grant is written and stored beside it, so the
/// authorization path never has to discover it. The chain always contains the
/// grant itself, so a root's lineage is one element long and the fence check
/// covers self-revocation with no special case.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lineage {
    chain: Vec<String>,
}

impl Lineage {
    /// The lineage of a grant with no parent.
    ///
    /// # Errors
    ///
    /// Returns [`LineageError::UnusableId`] when the id cannot appear in a
    /// materialized path.
    pub fn root(grant_id: &str) -> Result<Self, LineageError> {
        if !is_fence_safe_id(grant_id) {
            return Err(LineageError::UnusableId(grant_id.to_string()));
        }
        Ok(Self {
            chain: vec![grant_id.to_string()],
        })
    }

    /// The lineage of a grant delegated from `parent`.
    ///
    /// # Errors
    ///
    /// Returns an error when the id is unusable, the chain would exceed
    /// [`MAX_FENCE_DEPTH`], or the id already appears above it.
    pub fn child_of(parent: &Self, grant_id: &str) -> Result<Self, LineageError> {
        if !is_fence_safe_id(grant_id) {
            return Err(LineageError::UnusableId(grant_id.to_string()));
        }
        if parent.chain.iter().any(|id| id == grant_id) {
            return Err(LineageError::Cycle(grant_id.to_string()));
        }
        let mut chain = parent.chain.clone();
        chain.push(grant_id.to_string());
        if chain.len() > MAX_FENCE_DEPTH {
            return Err(LineageError::TooDeep(chain.len()));
        }
        Ok(Self { chain })
    }

    /// Rebuild a lineage from its stored materialized path.
    ///
    /// # Errors
    ///
    /// Returns an error when the path is not `/a/b/`-shaped, carries an
    /// unusable id, repeats an id, or is deeper than [`MAX_FENCE_DEPTH`].
    pub fn from_path(path: &str) -> Result<Self, LineageError> {
        let malformed = || LineageError::MalformedPath(path.to_string());
        let inner = path
            .strip_prefix(SEPARATOR)
            .and_then(|rest| rest.strip_suffix(SEPARATOR))
            .ok_or_else(malformed)?;
        if inner.is_empty() {
            return Err(malformed());
        }
        let mut chain: Vec<String> = Vec::new();
        for segment in inner.split(SEPARATOR) {
            if !is_fence_safe_id(segment) {
                return Err(LineageError::UnusableId(segment.to_string()));
            }
            if chain.iter().any(|id| id == segment) {
                return Err(LineageError::Cycle(segment.to_string()));
            }
            chain.push(segment.to_string());
        }
        if chain.len() > MAX_FENCE_DEPTH {
            return Err(LineageError::TooDeep(chain.len()));
        }
        Ok(Self { chain })
    }

    /// The stored form: every id in order, separator-delimited, both ends
    /// closed so a prefix match cannot stop mid-id.
    #[must_use]
    pub fn path(&self) -> String {
        let mut path = String::with_capacity(self.chain.len() * 38 + 1);
        path.push(SEPARATOR);
        for id in &self.chain {
            path.push_str(id);
            path.push(SEPARATOR);
        }
        path
    }

    /// Half-open key range covering this grant and every descendant of it.
    ///
    /// Returned as `[low, high)` over the stored path rather than as a `LIKE`
    /// pattern, for two reasons. A range comparison uses the path index
    /// unconditionally, where `LIKE 'prefix%'` only does so under the right
    /// `case_sensitive_like` pragma — so the cascade stays one indexed scan
    /// instead of degrading into a table walk nobody notices. And a range
    /// carries no pattern metacharacters at all, so there is no escaping to
    /// get wrong on top of [`is_fence_safe_id`].
    ///
    /// The upper bound is the path with its trailing [`SEPARATOR`] (`/`,
    /// `0x2F`) replaced by the next code point (`0`, `0x30`). Every string
    /// beginning `…/` sorts below `…0`, and nothing else does, so the range is
    /// exactly the subtree: a sibling whose id merely *starts* with this one's
    /// cannot be caught, because the separator is inside the bound.
    #[must_use]
    pub fn subtree_bounds(&self) -> (String, String) {
        let low = self.path();
        let mut high = low.clone();
        high.pop();
        high.push(SUBTREE_UPPER);
        (low, high)
    }

    /// The grant this lineage belongs to.
    #[must_use]
    pub fn grant_id(&self) -> &str {
        // The chain is never empty: every constructor pushes at least one id.
        self.chain.last().map_or("", String::as_str)
    }

    /// The top of the chain — the grant whose revocation stops everything
    /// below it.
    #[must_use]
    pub fn root_id(&self) -> &str {
        self.chain.first().map_or("", String::as_str)
    }

    /// The parent, or `None` for a root.
    #[must_use]
    pub fn parent_id(&self) -> Option<&str> {
        if self.chain.len() < 2 {
            return None;
        }
        self.chain.get(self.chain.len() - 2).map(String::as_str)
    }

    /// How far below the root this grant sits; a root is `0`.
    #[must_use]
    pub fn depth(&self) -> u32 {
        // A chain longer than u32::MAX is impossible under MAX_FENCE_DEPTH.
        u32::try_from(self.chain.len().saturating_sub(1)).unwrap_or(u32::MAX)
    }

    /// Every id the fence must find un-invalidated, root first, **including
    /// this grant itself**.
    #[must_use]
    pub fn chain(&self) -> &[String] {
        &self.chain
    }

    /// Whether `grant_id` is this grant or one of its ancestors.
    #[must_use]
    pub fn covers(&self, grant_id: &str) -> bool {
        self.chain.iter().any(|id| id == grant_id)
    }
}

#[cfg(test)]
#[path = "lineage_tests.rs"]
mod lineage_tests;
