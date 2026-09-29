//! The operator's hook policy: inert data, strictly parsed, never code.
//!
//! The hooks research (`docs/research/hooks-ecosystem.md` §2.1, §2.5) is the
//! reason this is a JSON document with a closed shape rather than a script or
//! a pattern language: a config file that causes execution is code, and most
//! gates in the wild are predicates that data can express. A rule names a
//! tool exactly, or by a literal prefix — no globs, no regular expressions,
//! nothing whose cost or meaning depends on the input it is matched against.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::labels::{first_fault, MAX_LABELS, MAX_LABEL_BYTES};

/// The only policy version this build reads.
pub const POLICY_VERSION: u32 = 1;

/// Longest `reason` a rule may carry. The interception record keeps `reason`
/// verbatim (spec §10.3), so it stays a short machine identifier.
pub const MAX_REASON_LEN: usize = 128;

/// What a tool rule decides at `pre_tool_call`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolDecision {
    /// The call proceeds (the secret guard still reads its arguments).
    Allow,
    /// A liftable deny: refused unless the host's approval seam lifts it.
    Escalate,
    /// A plain deny: nothing lifts it.
    Deny,
}

/// What the guard does with credential-shaped strings (see [`crate::secrets`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretGuard {
    /// Rewrite them to a marker wherever the spec permits a `transform`; deny
    /// them in tool arguments, where a rewrite would send the tool garbage.
    #[default]
    Redact,
    /// Deny every emission that carries one.
    Deny,
    /// Do not look.
    Off,
}

/// One tool rule. Exactly one of `name` and `prefix`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolRule {
    /// The tool's exact name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// A literal prefix of the tool's name (`github.` covers `github.issues`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    /// What the rule decides.
    pub decision: ToolDecision,
    /// Machine reason for the verdict; defaults to an `opensesame:` reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Human message for the verdict.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Labels the tool's results carry: at `post_tool_call` the permit
    /// verdict names them in `result_labels` (spec §5.4), so the host keeps
    /// them beside the result (`acme:pii` on a CRM lookup).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    /// Labels the tool's inputs may not derive from: at `pre_tool_call` a
    /// context whose `extensions.opensesame.source_labels` names one is a
    /// plain deny (see [`crate::labels`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refuse_labels: Vec<String>,
}

/// The whole policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookPolicy {
    /// Must be [`POLICY_VERSION`].
    pub version: u32,
    /// Tool rules. An exact `name` beats every `prefix`; the longest prefix
    /// beats a shorter one.
    #[serde(default)]
    pub tools: Vec<ToolRule>,
    /// What a tool no rule names gets. Defaults to `escalate`: an unknown
    /// tool is refused unless a person lifts it.
    #[serde(default = "default_unlisted")]
    pub unlisted_tools: ToolDecision,
    /// What the guard does with credential-shaped strings.
    #[serde(default)]
    pub secret_guard: SecretGuard,
    /// Labels no tool's inputs may derive from, on top of each rule's own
    /// `refuse_labels` — `opensesame:credential_material` refuses every tool
    /// call once credential material has flowed into its inputs.
    #[serde(default)]
    pub refuse_labels: Vec<String>,
}

const fn default_unlisted() -> ToolDecision {
    ToolDecision::Escalate
}

impl Default for HookPolicy {
    fn default() -> Self {
        Self {
            version: POLICY_VERSION,
            tools: Vec::new(),
            unlisted_tools: default_unlisted(),
            secret_guard: SecretGuard::default(),
            refuse_labels: Vec::new(),
        }
    }
}

/// Why a policy was refused. Every variant names a rule by its position,
/// never by echoing an arbitrary string back.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum PolicyError {
    /// Not JSON, or not this shape (unknown fields are refused).
    #[error("hook policy is not a valid policy document: {0}")]
    Malformed(String),
    /// A version this build does not read.
    #[error("hook policy version {0} is not supported (expected {POLICY_VERSION})")]
    Version(u32),
    /// A rule names neither a tool nor a prefix, or both.
    #[error("tools[{0}] must set exactly one of `name` and `prefix`, non-empty")]
    Selector(usize),
    /// Two rules claim the same name or the same prefix.
    #[error("tools[{0}] repeats a name or prefix an earlier rule already claims")]
    Duplicate(usize),
    /// A reason that is empty, too long, not a single token, or `host_error:`.
    #[error("tools[{0}].reason must be 1..={MAX_REASON_LEN} visible ASCII characters and must not start with `host_error:`")]
    Reason(usize),
    /// A policy-wide label list (`list`) with a malformed, over-long or
    /// repeated label at `index`, or more than [`MAX_LABELS`] of them.
    #[error("{list}[{index}] must be a distinct `namespace:name` label ({LABEL_PATTERN}, at most {MAX_LABEL_BYTES} bytes), and a list holds at most {MAX_LABELS}")]
    Label {
        /// The list's field name.
        list: &'static str,
        /// The first offending position.
        index: usize,
    },
    /// The same for a rule's own label list.
    #[error("tools[{rule}].{list}[{index}] must be a distinct `namespace:name` label ({LABEL_PATTERN}, at most {MAX_LABEL_BYTES} bytes), and a list holds at most {MAX_LABELS}")]
    RuleLabel {
        /// The rule's position.
        rule: usize,
        /// The list's field name.
        list: &'static str,
        /// The first offending position.
        index: usize,
    },
}

/// The label syntax [`crate::labels::is_label`] checks, as errors state it.
const LABEL_PATTERN: &str = "^[a-z][a-z0-9_]*:[a-z0-9_.:-]+$";

/// The rule that applies to one tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolMatch<'a> {
    /// The labels the tool's results carry (empty for an unlisted tool).
    pub labels: &'a [String],
    /// The labels the tool's inputs may not derive from, beside the
    /// policy-wide [`HookPolicy::refuse_labels`].
    pub refuse_labels: &'a [String],
    /// The decision.
    pub decision: ToolDecision,
    /// The rule's own reason, if it set one.
    pub reason: Option<&'a str>,
    /// The rule's own message, if it set one.
    pub message: Option<&'a str>,
}

impl ToolRule {
    /// The first unusable entry of either label list, by field and position.
    fn label_fault(&self) -> Option<(&'static str, usize)> {
        [
            ("labels", &self.labels),
            ("refuse_labels", &self.refuse_labels),
        ]
        .into_iter()
        .find_map(|(list, labels)| first_fault(labels).map(|at| (list, at)))
    }
}

fn reason_ok(reason: &str) -> bool {
    !reason.is_empty()
        && reason.len() <= MAX_REASON_LEN
        && reason.bytes().all(|b| b.is_ascii_graphic())
        && !reason.starts_with("host_error:")
}

impl HookPolicy {
    /// Parse and check a policy document.
    ///
    /// # Errors
    ///
    /// [`PolicyError`] when the document is malformed, of another version,
    /// or has an ambiguous or unusable rule.
    pub fn parse(text: &str) -> Result<Self, PolicyError> {
        let policy: Self =
            serde_json::from_str(text).map_err(|e| PolicyError::Malformed(e.to_string()))?;
        policy.check()?;
        Ok(policy)
    }

    /// Check a policy built in code the way [`Self::parse`] checks a document.
    ///
    /// # Errors
    ///
    /// The same [`PolicyError`]s as [`Self::parse`], bar `Malformed`.
    pub fn check(&self) -> Result<(), PolicyError> {
        if self.version != POLICY_VERSION {
            return Err(PolicyError::Version(self.version));
        }
        if let Some(index) = first_fault(&self.refuse_labels) {
            return Err(PolicyError::Label {
                list: "refuse_labels",
                index,
            });
        }
        let mut names = BTreeSet::new();
        let mut prefixes = BTreeSet::new();
        for (index, rule) in self.tools.iter().enumerate() {
            let fresh = match (rule.name.as_deref(), rule.prefix.as_deref()) {
                (Some(name), None) if !name.is_empty() => names.insert(name),
                (None, Some(prefix)) if !prefix.is_empty() => prefixes.insert(prefix),
                _ => return Err(PolicyError::Selector(index)),
            };
            if !fresh {
                return Err(PolicyError::Duplicate(index));
            }
            if rule.reason.as_deref().is_some_and(|r| !reason_ok(r)) {
                return Err(PolicyError::Reason(index));
            }
            if let Some((list, at)) = rule.label_fault() {
                return Err(PolicyError::RuleLabel {
                    rule: index,
                    list,
                    index: at,
                });
            }
        }
        Ok(())
    }

    /// The rule for `tool`: its exact rule, else its longest prefix rule,
    /// else `unlisted_tools`.
    #[must_use]
    pub fn tool(&self, tool: &str) -> ToolMatch<'_> {
        let exact = self
            .tools
            .iter()
            .find(|rule| rule.name.as_deref() == Some(tool));
        let rule = exact.or_else(|| {
            self.tools
                .iter()
                .filter(|rule| rule.prefix.as_deref().is_some_and(|p| tool.starts_with(p)))
                .max_by_key(|rule| rule.prefix.as_deref().map_or(0, str::len))
        });
        rule.map_or(
            ToolMatch {
                labels: &[],
                refuse_labels: &[],
                decision: self.unlisted_tools,
                reason: None,
                message: None,
            },
            |rule| ToolMatch {
                labels: &rule.labels,
                refuse_labels: &rule.refuse_labels,
                decision: rule.decision,
                reason: rule.reason.as_deref(),
                message: rule.message.as_deref(),
            },
        )
    }
}
