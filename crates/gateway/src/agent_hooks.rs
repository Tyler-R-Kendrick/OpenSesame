//! The Host's side of agent-hooks/0.1 (ADR 0159): each organization's hook
//! policy, and the value-blind record of every verdict answered under it.
//!
//! Everything that decides under an organization's policy loads it through
//! [`load_policy`], so the remote interceptor route and any Host-run agent
//! loop apply the same document and report the same version. A stored policy
//! this build cannot read is an error, never a quiet fall back to the
//! default: the caller answers it as a failure, which a conformant host turns
//! into a deny (spec §6.3).
//!
//! A decision's audit record keeps the interception point, the decision, the
//! reason and the policy version — never the tool name, the target, a
//! transform's value or a verdict's message, any of which can carry the
//! content the guard exists to keep out of logs (spec §14). It is a row in
//! `agent_hook_decisions`, not an outbox event: an audit trail is not a change
//! feed, and on the outbox every caller's traffic became a dead letter or a
//! no-change snapshot commit in the backup actor and grew the outbox without
//! bound. Retention trims it ([`crate::retention`]).

use anyhow::Context as _;
use opensesame_agent_hooks::interceptor::{MAX_CONTEXT_BYTES, REASON_CONTEXT_UNREADABLE};
use opensesame_agent_hooks::sdk::{InterceptionPoint, Verdict};
use opensesame_agent_hooks::{HookPolicy, OpenSesameInterceptor};
use opensesame_domain::OrganizationId;
use opensesame_storage::agent_hook_policy::decisions::NewAgentHookDecision;
use opensesame_storage::agent_hook_policy::StoredAgentHookPolicy;
use opensesame_storage::Db;
use serde::Deserialize;

/// Outbox event for a replaced policy. Rare (an operator's edit), and a
/// change to configuration a snapshot should carry, so it stays on the
/// outbox: the backup actor drains it like any other event.
pub(crate) const EVENT_POLICY_UPDATED: &str = "agent_hooks.policy.updated";

/// What an audit record says when a verdict's reason is not a short machine
/// identifier. Every reason the interceptor emits is one; this only keeps a
/// future reason from carrying prose into the trail.
const REASON_WITHHELD: &str = "opensesame:reason_withheld";
/// Longest reason an audit record keeps verbatim (the policy's own bound).
const MAX_AUDIT_REASON: usize = opensesame_agent_hooks::policy::MAX_REASON_LEN;

/// An organization's policy as the Host decides with it.
#[derive(Debug, Clone)]
pub(crate) struct LoadedHookPolicy {
    /// The policy, defaults filled; [`HookPolicy::default`] when none is stored.
    pub policy: HookPolicy,
    /// The compare-and-set version; 0 when none is stored.
    pub version: i64,
    /// The stored row's metadata, when there is one.
    pub stored: Option<StoredAgentHookPolicy>,
}

impl LoadedHookPolicy {
    /// An interceptor over this policy.
    pub(crate) fn interceptor(&self) -> OpenSesameInterceptor {
        OpenSesameInterceptor::new(self.policy.clone())
    }
}

/// The organization's agent-hooks policy, or the built-in default at version
/// 0 when it has none.
///
/// # Errors
///
/// The store cannot be read, or the stored document no longer parses (a
/// policy written by a newer build). Fail closed: never decide under the
/// default in its place.
pub(crate) async fn load_policy(
    db: &Db,
    organization_id: &OrganizationId,
) -> anyhow::Result<LoadedHookPolicy> {
    let Some(stored) = db.agent_hook_policy(&organization_id.to_string()).await? else {
        return Ok(LoadedHookPolicy {
            policy: HookPolicy::default(),
            version: 0,
            stored: None,
        });
    };
    let policy = HookPolicy::parse(&stored.policy_json)
        .context("the stored agent-hooks policy does not parse")?;
    Ok(LoadedHookPolicy {
        policy,
        version: stored.version,
        stored: Some(stored),
    })
}

/// The verdict for a context over [`MAX_CONTEXT_BYTES`] — the one
/// `decide_json` gives, answered without reading the rest of the body.
pub(crate) fn oversized_verdict() -> Verdict {
    Verdict::deny(
        Some(REASON_CONTEXT_UNREADABLE.into()),
        Some(format!(
            "context exceeds {MAX_CONTEXT_BYTES} bytes (agent-hooks/0.1 §12.3)"
        )),
    )
}

/// The verdict for a body that is not UTF-8, so not JSON (RFC 8259 §8.1) —
/// the one `opensesame hooks intercept` gives. Never repaired: a lossy decode
/// would put replacement characters into a transformed target.
pub(crate) fn not_utf8_verdict() -> Verdict {
    Verdict::deny(
        Some(REASON_CONTEXT_UNREADABLE.into()),
        Some("context is not UTF-8 JSON".into()),
    )
}

#[derive(Deserialize)]
struct PointOnly {
    #[serde(default)]
    interception_point: Option<InterceptionPoint>,
}

/// The context's interception point, when it names one of the eight — the
/// closed enum, never the text the caller sent.
pub(crate) fn interception_point(text: &str) -> Option<InterceptionPoint> {
    serde_json::from_str::<PointOnly>(text)
        .ok()
        .and_then(|only| only.interception_point)
}

pub(crate) fn audit_reason(verdict: &Verdict) -> Option<&str> {
    verdict.reason.as_deref().map(machine_reason)
}

/// `reason` when it is a short machine identifier, else a fixed marker — the
/// only form a verdict's reason takes in a record, a job detail or a log.
pub(crate) fn machine_reason(reason: &str) -> &str {
    if !reason.is_empty()
        && reason.len() <= MAX_AUDIT_REASON
        && reason.bytes().all(|b| b.is_ascii_graphic())
    {
        reason
    } else {
        REASON_WITHHELD
    }
}

/// One answered interception, as the audit trail keeps it.
pub(crate) struct DecisionRecord<'a> {
    pub organization_id: &'a OrganizationId,
    /// Who asked: `operator` or the session's principal.
    pub caller: &'a str,
    pub point: Option<InterceptionPoint>,
    pub verdict: &'a Verdict,
    pub policy_version: i64,
}

/// Append the decision's audit row.
///
/// # Errors
///
/// The insert fails. The caller must not hand the verdict out unrecorded.
pub(crate) async fn record_decision(db: &Db, record: &DecisionRecord<'_>) -> anyhow::Result<()> {
    let organization_id = record.organization_id.to_string();
    let created_at = chrono::Utc::now().to_rfc3339();
    db.append_agent_hook_decision(&NewAgentHookDecision {
        organization_id: &organization_id,
        caller: record.caller,
        interception_point: record.point.map(InterceptionPoint::as_str),
        decision: record.verdict.decision.as_str(),
        escalated: record.verdict.approval.is_some(),
        reason: audit_reason(record.verdict),
        policy_version: record.policy_version,
        created_at: &created_at,
    })
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_oversized_verdict_is_the_one_decide_json_gives() {
        let interceptor = OpenSesameInterceptor::default();
        let oversized = " ".repeat(MAX_CONTEXT_BYTES + 1);
        assert_eq!(
            serde_json::to_value(interceptor.decide_json(&oversized)).unwrap(),
            serde_json::to_value(oversized_verdict()).unwrap()
        );
    }

    #[test]
    fn only_a_named_point_is_read_back() {
        assert_eq!(
            interception_point(r#"{"interception_point":"pre_tool_call"}"#),
            Some(InterceptionPoint::PreToolCall)
        );
        for text in [
            r#"{"interception_point":"ghp_not_a_point"}"#,
            r#"{"target":"x"}"#,
            "not json",
        ] {
            assert_eq!(interception_point(text), None, "{text}");
        }
    }

    #[tokio::test]
    async fn a_record_carries_no_message_transform_or_prose_reason() {
        use opensesame_storage::agent_hook_policy::decisions::AgentHookDecisionFilter;

        let db = Db::connect_memory().await.unwrap();
        let organization_id = OrganizationId::new();
        let secret = format!("ghp_{}", "x".repeat(36));
        let verdict = Verdict::deny(
            Some(format!("an operator reason with {secret}")),
            Some(format!("message naming {secret}")),
        );
        let record = DecisionRecord {
            organization_id: &organization_id,
            caller: "operator",
            point: Some(InterceptionPoint::Output),
            verdict: &verdict,
            policy_version: 3,
        };
        record_decision(&db, &record).await.unwrap();
        let named = Verdict::deny(Some("opensesame:secret_redacted".into()), None);
        record_decision(
            &db,
            &DecisionRecord {
                verdict: &named,
                ..record
            },
        )
        .await
        .unwrap();

        let org = organization_id.to_string();
        let rows = db
            .list_agent_hook_decisions(&org, &AgentHookDecisionFilter::default(), None, 10)
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        let (named_row, prose_row) = (&rows[0], &rows[1]);
        assert_eq!(prose_row.reason.as_deref(), Some(REASON_WITHHELD));
        assert_eq!(prose_row.decision, "deny");
        assert_eq!(prose_row.interception_point.as_deref(), Some("output"));
        assert_eq!(prose_row.policy_version, 3);
        assert!(!format!("{rows:?}").contains(&secret));
        assert_eq!(
            named_row.reason.as_deref(),
            Some("opensesame:secret_redacted")
        );
        // An audit row is never a change event: the backup actor sees nothing.
        assert_eq!(db.count_unpublished_outbox().await.unwrap(), 0);
    }

    #[tokio::test]
    async fn policy_updates_are_tolerated_by_the_backup_actor_and_decisions_never_reach_it() {
        use opensesame_storage::agent_hook_policy::{AgentHookPolicyAudit, AgentHookPolicyWrite};

        let state = crate::app_state::test_demo_state().await;
        let organization_id = state.connection_organization;
        // Agent traffic, however much: none of it is the backup actor's.
        let verdict = Verdict::allow();
        for _ in 0..25 {
            record_decision(
                &state.db,
                &DecisionRecord {
                    organization_id: &organization_id,
                    caller: "operator",
                    point: Some(InterceptionPoint::Input),
                    verdict: &verdict,
                    policy_version: 0,
                },
            )
            .await
            .unwrap();
        }
        assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 0);

        // A policy update is rare, and it does stay on the outbox: the actor
        // drains it like any other event (here, with no backup target, by
        // dead-lettering it) and does not fail on it.
        let org = organization_id.to_string();
        let payload = serde_json::json!({"organization_id": org, "version": 1}).to_string();
        state
            .db
            .put_agent_hook_policy(
                &AgentHookPolicyWrite {
                    organization_id: &org,
                    policy_json: r#"{"version":1}"#,
                    expected_version: 0,
                    updated_by: "operator",
                },
                &AgentHookPolicyAudit {
                    event_type: EVENT_POLICY_UPDATED,
                    payload_json: &payload,
                },
            )
            .await
            .unwrap();
        assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 1);
        crate::backup::pass(&state, &crate::backup::github_api_base(), &mut None)
            .await
            .unwrap();
        assert_eq!(state.db.count_unpublished_outbox().await.unwrap(), 0);
    }
}
