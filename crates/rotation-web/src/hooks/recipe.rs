//! What every emission of a session is made from, and the emitter it gets.
//!
//! The SDK's [`InterceptionEmitter`] takes `&mut self` to emit, because it
//! buffers records — but nothing else in it changes between emissions: the
//! interceptors, the resolver, the composition profile, the identity provider
//! and the approval redactor are all fixed at construction, and dispatch only
//! reads them. So the session keeps those as shared, immutable parts (a
//! [`Recipe`]) and builds a **fresh emitter for each emission** from clones of
//! the `Arc`s. Nothing about composition, the fold, the identity, the approval
//! echo rule or the record projection is reimplemented: every emission is run
//! by the SDK's own `emit_unchecked`, exactly as before. What changes is that
//! two emissions no longer need one shared `&mut` emitter, and so no lock has
//! to be held while one of them awaits an interceptor or the approval seam.

use std::sync::Arc;

use agent_hooks::{
    AgentContext, ApprovalRequest, ApprovalResolution, ApprovalResolver, CompositionConfig,
    EnforcementMode, HostError, IdentityProvider, InterceptionEmitter, Interceptor,
};
use async_trait::async_trait;

use super::labels::{instrument, Noted, Registered};

type Redactor = Arc<dyn Fn(&AgentContext) -> AgentContext + Send + Sync>;
type IdentityFn = Arc<dyn Fn(&AgentContext) -> String + Send + Sync>;

/// [`IdentityProvider`] without the box, so each emitter can have its own.
pub(super) enum Identity {
    JcsSha256,
    Null,
    Custom { name: String, f: IdentityFn },
}

impl From<IdentityProvider> for Identity {
    fn from(provider: IdentityProvider) -> Self {
        match provider {
            IdentityProvider::JcsSha256 => Self::JcsSha256,
            IdentityProvider::Null => Self::Null,
            IdentityProvider::Custom { name, f } => Self::Custom {
                name,
                f: Arc::from(f),
            },
        }
    }
}

impl Identity {
    /// A provider for one emitter. A custom provider's name is validated by
    /// the SDK here (§10.1), which is also what rejects a bad name at
    /// construction.
    fn provider(&self) -> Result<IdentityProvider, HostError> {
        match self {
            Self::JcsSha256 => Ok(IdentityProvider::JcsSha256),
            Self::Null => Ok(IdentityProvider::Null),
            Self::Custom { name, f } => {
                let f = Arc::clone(f);
                IdentityProvider::custom(name.clone(), move |context| f(context))
                    .map_err(|(error, _)| error)
            }
        }
    }
}

/// The approval seam, shared: the SDK takes it by `Box`, one per emitter.
struct SharedResolver(Arc<dyn ApprovalResolver>);

#[async_trait]
impl ApprovalResolver for SharedResolver {
    async fn resolve(&self, request: ApprovalRequest<'_>) -> ApprovalResolution {
        self.0.resolve(request).await
    }
}

pub(super) struct Recipe {
    pub(super) mode: EnforcementMode,
    pub(super) composition: CompositionConfig,
    pub(super) identity: Identity,
    pub(super) interceptors: Vec<Registered>,
    pub(super) resolver: Option<Arc<dyn ApprovalResolver>>,
    pub(super) redactor: Option<Redactor>,
}

impl Recipe {
    pub(super) fn set_redactor(
        &mut self,
        redactor: impl Fn(&AgentContext) -> AgentContext + Send + Sync + 'static,
    ) {
        self.redactor = Some(Arc::new(redactor));
    }

    pub(super) fn register(&mut self, interceptor: Box<dyn Interceptor>) {
        self.interceptors.push(Registered::new(interceptor));
    }

    /// An emitter for one emission, and the buffer its interceptors note
    /// their result labels into.
    ///
    /// # Errors
    ///
    /// [`HostError::ContextInvalid`] when a custom identity provider's name
    /// breaks the §10.1 naming rules.
    pub(super) fn emitter(&self) -> Result<(InterceptionEmitter, Noted), HostError> {
        let resolver = self.resolver.as_ref().map(|resolver| {
            Box::new(SharedResolver(Arc::clone(resolver))) as Box<dyn ApprovalResolver>
        });
        let mut emitter = InterceptionEmitter::new(self.mode, resolver);
        emitter.set_composition(self.composition);
        emitter
            .set_identity_provider(self.identity.provider()?)
            .map_err(|(error, _)| error)?;
        if let Some(redactor) = &self.redactor {
            let redactor = Arc::clone(redactor);
            emitter.set_approval_redactor(move |context| redactor(context));
        }
        let (interceptors, noted) = instrument(&self.interceptors);
        for interceptor in interceptors {
            emitter.register(interceptor);
        }
        Ok((emitter, noted))
    }
}
