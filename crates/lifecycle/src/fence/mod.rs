//! Root/ancestor invalidation fencing for delegated authority.
//!
//! A delegation chain is a line of grants, each narrowing the one above it.
//! Revoking a grant has to stop every descendant, and it has to stop them
//! *now* — not once a background job has finished walking the tree. The
//! window between "the owner pressed revoke" and "the walk reached this
//! child" is authority that outlived its ancestor, and a child that is still
//! honoured inside that window is the whole bug.
//!
//! The fence closes it by inverting the direction of the work. Instead of
//! pushing revocation down to descendants, a revoke writes **one** durable
//! invalidation row for the grant it names, and every authorization pulls the
//! answer up: a grant carries its materialized lineage — root first, itself
//! last — so "is any ancestor dead?" is a set membership test against ids the
//! grant already knows, bounded by [`MAX_FENCE_DEPTH`]. There is no recursion
//! to schedule, nothing to catch up, and no moment where the descendant is
//! live because the walk has not arrived. Cascading the `revoked_at` columns
//! still happens, but it is bookkeeping for listings and receipts; it is not
//! what enforces, so it may lag without ever widening authority.
//!
//! This module is the *decision*, and like the rest of the crate it does no
//! I/O and cannot see a credential: a [`Lineage`] is a list of opaque ids and
//! a [`FenceReading`] is what some store reported about them. The storage
//! half lives beside the grants it fences
//! (`crates/storage/src/authority_fence.rs`), which is also where the
//! linearization point is documented — see ADR 0121.
//!
//! ## Fail closed on uncertainty
//!
//! Three answers, not two. [`FenceVerdict::Clear`] is reachable only from an
//! affirmative, complete, fresh reading of a well-formed lineage; everything
//! else — a grant with no lineage row, a chain that does not reach its own
//! declared root, a store that could not answer, a reading from behind a
//! sequence the caller has already observed — is
//! [`FenceVerdict::Indeterminate`], and a caller must treat that exactly like
//! [`FenceVerdict::Invalidated`]. "Could not tell" is never "probably fine":
//! that is how a slow query or a half-applied migration becomes a revocation
//! bypass. [`FenceVerdict::authorizes`] is the only way to ask, and it
//! answers `true` for one variant.

mod lineage;
mod verdict;

pub use lineage::{is_fence_safe_id, Lineage, LineageError};
pub use verdict::{
    evaluate_fence, missing_lineage, store_unavailable, FenceReading, FenceVerdict, Freshness,
    Invalidation, Uncertainty,
};

/// The deepest chain the fence will evaluate.
///
/// A lineage is checked in full on every authorization, so its length is a
/// per-request cost and an unbounded one is a denial-of-service surface. The
/// ceiling is far above any grant `maximum_delegation_depth` in practice; a
/// chain past it is refused rather than truncated, because a truncated chain
/// is one whose upper ancestors were never checked.
pub const MAX_FENCE_DEPTH: usize = 16;

/// The separator that delimits ids in a materialized path.
const SEPARATOR: char = '/';

/// The code point immediately after [`SEPARATOR`], used as the exclusive upper
/// bound of a subtree range. See [`Lineage::subtree_bounds`].
const SUBTREE_UPPER: char = '0';
