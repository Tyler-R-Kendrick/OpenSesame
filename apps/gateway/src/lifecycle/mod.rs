//! Expiry lifecycle hooks (ADR 0073).
//!
//! When something with a deadline approaches it, that is a fact the platform
//! detects once and publishes once, on a feed anyone can subscribe to:
//!
//! ```text
//! subjects::collect  →  opensesame_lifecycle::evaluate  →  dispatch::publish
//!                                                            ├─ TaskBus
//!                                                            ├─ delivery ledger → delivery::run
//!                                                            └─ responders::respond
//! ```
//!
//! The dogfooding rule is the point of the shape. `OpenSesame`'s own rotation
//! runs through [`responders`], which is driven by the same
//! `lifecycle.renewal.due` event a third-party tool receives. The rotation
//! scheduler no longer has a private "is this policy due?" check; it consumes
//! the feed. If the feed breaks, our rotations break with it — which is the
//! only reliable way to keep a published event contract from rotting.
//!
//! Nothing on this path carries credential material. Subjects are metadata,
//! payloads are assembled key by key, and both the domain crate and the route
//! layer carry structural tests that keep it that way.

pub mod delivery;
pub mod dispatch;
pub mod responders;
pub mod scanner;
pub mod subjects;
