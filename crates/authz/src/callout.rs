//! NATS auth callout admission helpers (Host plane).
//!
//! Decisions are allow/deny + pub/sub permission lists. Identity mapping and
//! token validation happen outside this module — callers must never pass an
//! email as a join key (ADR 0042 / identity-link assurance).

use serde::{Deserialize, Serialize};

/// Why a callout request was denied.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalloutDenyReason {
    /// Token / client issuer is not on the Host allowlist.
    UnknownIssuer,
    /// Caller attempted email-only correlation (forbidden).
    EmailJoinForbidden,
    /// Issuer+subject has no PrincipalMapping / external identity row.
    UnmappedPrincipal,
    /// Request missing required issuer or subject.
    MissingIdentity,
}

impl CalloutDenyReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::UnknownIssuer => "unknown_issuer",
            Self::EmailJoinForbidden => "email_join_forbidden",
            Self::UnmappedPrincipal => "unmapped_principal",
            Self::MissingIdentity => "missing_identity",
        }
    }
}

/// Pub/sub permission set returned with an allow decision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CalloutPermissions {
    pub publish: Vec<String>,
    pub subscribe: Vec<String>,
}

/// Successful callout admission.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CalloutAllow {
    pub principal_id: String,
    pub provisional: bool,
    pub permissions: CalloutPermissions,
}

/// Inputs already validated by the Host callout route (issuer allowlist, etc.).
#[derive(Clone, Debug)]
pub struct CalloutEval {
    /// True when the presented issuer is on the configured allowlist.
    pub issuer_allowed: bool,
    /// True when the client asked to join/correlate by email alone.
    pub email_join_attempted: bool,
    /// Upstream issuer from the token / CONNECT opts (empty if absent).
    pub issuer: String,
    /// Upstream subject — never an email join key.
    pub subject: String,
    /// Canonical principal from Identity mapping resolve (issuer+subject only).
    pub mapped_principal_id: Option<String>,
    pub provisional: bool,
    /// Verified org/project memberships used to scope bus subjects.
    pub project_ids: Vec<String>,
}

/// Build minimal vs project-scoped NATS subjects for a principal.
///
/// Provisional principals get only the opaque capability inbox under
/// `opensesame.callout.>` — never project event streams and never Host
/// `opensesame.events.system.>` subjects.
pub fn callout_permissions(principal_id: &str, provisional: bool, project_ids: &[String]) -> CalloutPermissions {
    if provisional {
        let inbox = format!("opensesame.callout.principal.{principal_id}.>");
        return CalloutPermissions {
            publish: vec![inbox.clone()],
            subscribe: vec![inbox],
        };
    }

    let mut publish = Vec::new();
    let mut subscribe = Vec::new();
    if project_ids.is_empty() {
        // Verified but no project membership yet: still more than provisional —
        // allow reading own capability subjects only.
        let inbox = format!("opensesame.callout.principal.{principal_id}.>");
        publish.push(inbox.clone());
        subscribe.push(inbox);
    } else {
        for project_id in project_ids {
            let subj = format!("opensesame.events.project.{project_id}.>");
            publish.push(subj.clone());
            subscribe.push(subj);
        }
    }
    // Never grant system.> — Host publishers only. Enforced in release too.
    publish.retain(|s| !subject_covers_system(s));
    subscribe.retain(|s| !subject_covers_system(s));
    CalloutPermissions { publish, subscribe }
}

fn subject_covers_system(subject: &str) -> bool {
    subject.contains("opensesame.events.system") || subject.contains(".system.")
}

/// True when a permission subject would cover Host system streams (forbidden for users).
pub fn permissions_include_system(permissions: &CalloutPermissions) -> bool {
    permissions
        .publish
        .iter()
        .chain(permissions.subscribe.iter())
        .any(|s| s.contains("opensesame.events.system") || s.contains(".system."))
}

/// Pure allow/deny evaluation for NATS auth callout.
pub fn evaluate_callout(eval: &CalloutEval) -> Result<CalloutAllow, CalloutDenyReason> {
    if eval.email_join_attempted {
        return Err(CalloutDenyReason::EmailJoinForbidden);
    }
    if !eval.issuer_allowed {
        return Err(CalloutDenyReason::UnknownIssuer);
    }
    if eval.issuer.trim().is_empty() || eval.subject.trim().is_empty() {
        return Err(CalloutDenyReason::MissingIdentity);
    }
    let Some(principal_id) = eval.mapped_principal_id.as_ref() else {
        return Err(CalloutDenyReason::UnmappedPrincipal);
    };
    if principal_id.trim().is_empty() {
        return Err(CalloutDenyReason::UnmappedPrincipal);
    }

    Ok(CalloutAllow {
        principal_id: principal_id.clone(),
        provisional: eval.provisional,
        permissions: callout_permissions(principal_id, eval.provisional, &eval.project_ids),
    })
}

/// Return true when `issuer` is present in a comma/whitespace-separated allowlist.
pub fn issuer_on_allowlist(issuer: &str, allowlist: &str) -> bool {
    let issuer = issuer.trim();
    if issuer.is_empty() || allowlist.trim().is_empty() {
        return false;
    }
    allowlist
        .split([',', ' ', '\n', '\t'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .any(|allowed| allowed == issuer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_eval() -> CalloutEval {
        CalloutEval {
            issuer_allowed: true,
            email_join_attempted: false,
            issuer: "https://identity.test".into(),
            subject: "oidc-sub-1".into(),
            mapped_principal_id: Some("prn_mapped".into()),
            provisional: false,
            project_ids: vec!["proj_a".into()],
        }
    }

    #[test]
    fn deny_unknown_issuer() {
        let mut e = base_eval();
        e.issuer_allowed = false;
        assert_eq!(
            evaluate_callout(&e),
            Err(CalloutDenyReason::UnknownIssuer)
        );
    }

    #[test]
    fn deny_email_join() {
        let mut e = base_eval();
        e.email_join_attempted = true;
        assert_eq!(
            evaluate_callout(&e),
            Err(CalloutDenyReason::EmailJoinForbidden)
        );
    }

    #[test]
    fn allow_mapped_principal_with_project_subjects() {
        let e = base_eval();
        let allow = evaluate_callout(&e).expect("allow");
        assert_eq!(allow.principal_id, "prn_mapped");
        assert!(!allow.provisional);
        assert_eq!(
            allow.permissions.publish,
            vec!["opensesame.events.project.proj_a.>".to_string()]
        );
    }

    #[test]
    fn provisional_gets_minimal_callout_subjects() {
        let mut e = base_eval();
        e.provisional = true;
        e.project_ids = vec!["proj_a".into()];
        let allow = evaluate_callout(&e).unwrap();
        assert!(allow.provisional);
        assert_eq!(
            allow.permissions.subscribe,
            vec!["opensesame.callout.principal.prn_mapped.>".to_string()]
        );
        assert!(
            !allow
                .permissions
                .publish
                .iter()
                .any(|s| s.contains("events.project")),
            "provisional must not get project event subjects"
        );
    }

    #[test]
    fn deny_unmapped() {
        let mut e = base_eval();
        e.mapped_principal_id = None;
        assert_eq!(
            evaluate_callout(&e),
            Err(CalloutDenyReason::UnmappedPrincipal)
        );
    }

    #[test]
    fn provisional_and_verified_never_get_system_subjects() {
        let e = base_eval();
        let allow = evaluate_callout(&e).unwrap();
        assert!(!permissions_include_system(&allow.permissions));
        let mut provisional = base_eval();
        provisional.provisional = true;
        let allow = evaluate_callout(&provisional).unwrap();
        assert!(!permissions_include_system(&allow.permissions));
    }

    #[test]
    fn issuer_allowlist_exact_match() {
        assert!(issuer_on_allowlist(
            "https://identity.test",
            "https://a.example, https://identity.test"
        ));
        assert!(!issuer_on_allowlist(
            "https://evil.example",
            "https://identity.test"
        ));
        assert!(!issuer_on_allowlist("https://identity.test", ""));
    }

    #[test]
    fn multi_issuer_allowlist_admits_any_listed_issuer() {
        let allowlist = "https://identity.a, https://identity.b\nhttps://identity.c";
        assert!(issuer_on_allowlist("https://identity.a", allowlist));
        assert!(issuer_on_allowlist("https://identity.b", allowlist));
        assert!(issuer_on_allowlist("https://identity.c", allowlist));
        assert!(!issuer_on_allowlist("https://identity.evil", allowlist));
    }

    #[test]
    fn callout_permissions_never_grant_system_wildcard() {
        let perms = callout_permissions("prn_x", false, &["proj_1".into(), "proj_2".into()]);
        assert!(!permissions_include_system(&perms));
        assert!(perms
            .publish
            .iter()
            .all(|s| s.starts_with("opensesame.events.project.")));
        assert!(!perms.publish.iter().any(|s| s.contains("system")));
    }
}
