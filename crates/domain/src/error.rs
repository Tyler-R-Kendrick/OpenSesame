use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DomainError {
    #[error("invalid id: {0}")]
    InvalidId(String),
    #[error("grant attenuation violated: {0}")]
    GrantAttenuation(String),
    #[error("delegation depth exceeded")]
    DelegationDepthExceeded,
    #[error("grant expired or not yet valid")]
    GrantTimeWindow,
    #[error("grant revoked")]
    GrantRevoked,
    #[error("canonicalization failed: {0}")]
    Canonicalization(String),
    #[error("availability class denied without authority quorum: {0:?}")]
    AuthorityUnavailable(crate::AvailabilityClass),
    #[error("organization boundary mismatch")]
    OrganizationMismatch,
    #[error("invalid transition {from} -> {to}")]
    InvalidTransition { from: String, to: String },
    #[error("raw credential export denied by policy")]
    ExportDenied,
    #[error("authority context invalid: {0}")]
    AuthorityContextInvalid(String),
    #[error("authority context locked after task activation")]
    AuthorityContextLocked,
    #[error("task ceiling compilation produced empty intersection")]
    TaskCeilingEmpty,
    #[error("task run is not active")]
    TaskNotActive,
    #[error("task authority expired")]
    TaskExpired,
    #[error("capability widen forbidden")]
    CapabilityWidenForbidden,
    #[error("task state version mismatch: expected {expected}, actual {actual}")]
    TaskStateVersionMismatch { expected: u64, actual: u64 },
    #[error("delegation chain cycle detected")]
    DelegationChainCycle,
    #[error("delegation chain invalid: {0}")]
    DelegationChainInvalid(String),
    #[error("proof key revoked")]
    ProofKeyRevoked,
    #[error("session grant lifetime invalid: {0}")]
    SessionGrantLifetime(String),
    #[error("session grant would widen an existing one: {0}")]
    SessionGrantWiden(String),
    #[error("session grant scope empty")]
    SessionGrantScopeEmpty,
    #[error("session join note too long: {0} characters")]
    SessionJoinNoteTooLong(usize),
    #[error("share link lifetime invalid: {0}")]
    SessionInviteLifetime(String),
    #[error("share link would outlive the access it carries: {0}")]
    SessionInviteOutlivesGrant(String),
    #[error("share link is not open: {0}")]
    SessionInviteClosed(String),
    #[error("session grant link was not checked against its source: {0}")]
    SessionGrantLinkUnchecked(String),
    #[error("an observer holds no reach; raise them to participant first")]
    SessionObserverHoldsNoGrant,
    #[error("session membership has ended")]
    SessionMembershipEnded,
    #[error("session is closed")]
    SessionClosed,
    #[error("proof binding mismatch: {0}")]
    ProofBindingMismatch(String),
    #[error("unknown protocol profile: {0}")]
    UnknownProtocolProfile(String),
    #[error("token presentation downgrade rejected")]
    TokenPresentationDowngrade,
    #[error("authorization denied: {0}")]
    AuthorizationDenied(String),
    #[error("mediation acknowledgement incomplete")]
    MediationAckIncomplete,
    #[error("mediation acknowledgement mismatch: {0}")]
    MediationAckMismatch(String),
    #[error("frozen intent digest untrusted or missing")]
    FrozenIntentDigestUntrusted,
    #[error("frozen intent digest mismatch")]
    FrozenIntentDigestMismatch,
    #[error("frozen intent migration denied: {0}")]
    FrozenIntentMigrationDenied(String),
    #[error("access domain is not in this realm: {0}")]
    AccessDomainRealmMismatch(String),
    #[error("access domain parentage would form a cycle: {0}")]
    AccessDomainCycle(String),
    #[error("access domain invalid: {0}")]
    AccessDomainInvalid(String),
    #[error("access domain not found: {0}")]
    AccessDomainNotFound(String),
    #[error("access domain conflict: {0}")]
    AccessDomainConflict(String),
    #[error("access domain depth exceeded: {0} levels")]
    AccessDomainDepthExceeded(usize),
    #[error("access domain lifetime invalid: {0}")]
    AccessDomainLifetime(String),
    #[error("access domain has expired")]
    AccessDomainExpired,
    #[error("access domain control would widen authority: {0}")]
    AccessDomainControlWiden(String),
    #[error("personal project refuses sharing: {0}")]
    AccessDomainPersonalSharing(String),
    #[error("access domain vault binding mismatch: {0}")]
    AccessDomainVaultBinding(String),
    #[error("cohort label invalid: {0}")]
    CohortLabelInvalid(String),
    #[error("cohort names no members")]
    CohortEmpty,
    #[error("cohort names too many members: {0}")]
    CohortTooManyMembers(usize),
    #[error("cohort nesting cycle: {0}")]
    CohortCycle(String),
    #[error("cohort nesting depth exceeded: {0}")]
    CohortDepthExceeded(usize),
    #[error("cohort graph larger than {0} cohorts")]
    CohortGraphTooLarge(usize),
    #[error("cohort would make more than {0} principals eligible")]
    CohortTooManyPrincipals(usize),
    #[error("cohort member could not be resolved: {0}")]
    CohortUnresolvedMember(String),
    #[error("cohort eligibility path invalid: {0}")]
    CohortPathInvalid(String),
    #[error("cohort admission mode mismatch: {0}")]
    CohortAdmissionModeMismatch(String),
    #[error("cohort resolution is not live enough: {0}")]
    CohortResolutionStale(String),
    #[error("cohort snapshot is closed: {0}")]
    CohortSnapshotClosed(String),
    #[error("cohort snapshot roster does not match its digest")]
    CohortSnapshotDigestMismatch,
    #[error("cohort snapshot belongs to a different cohort")]
    CohortSnapshotCohortMismatch,
    #[error("principal is not eligible: {0}")]
    CohortNotEligible(String),
    #[error("cohort activation lifetime invalid: {0}")]
    CohortActivationLifetime(String),
    #[error("cohort activation binding mismatch: {0}")]
    CohortActivationBindingMismatch(String),
    #[error("cohort activation already spent")]
    CohortActivationSpent,
    #[error("permission entry invalid: {0}")]
    PermissionEntryInvalid(String),
    #[error("permission correlation lost: {0}")]
    PermissionCorrelationLost(String),
    #[error("permission role unknown: {0}")]
    PermissionRoleUnknown(String),
    #[error("resource selector invalid: {0}")]
    ResourceSelectorInvalid(String),
}
