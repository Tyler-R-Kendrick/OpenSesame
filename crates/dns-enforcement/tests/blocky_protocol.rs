//! Protocol tests against a real Blocky instance (DNS-TEST).
//!
//! These assert the three things that cannot be checked without a server: that
//! granting a domain leaves blocking *on*, that a refresh actually changes what
//! the resolver answers, and that a scoped disable behaves the way the pinned
//! version documents.
//!
//! # Running them
//!
//! `harness/blocky-env.sh up` builds the pinned Blocky, writes a disposable
//! config, starts it, and prints the environment to export:
//!
//! ```text
//! eval "$(crates/dns-enforcement/harness/blocky-env.sh up)"
//! cargo +1.88.0 test -p opensesame-dns-enforcement --test blocky_protocol
//! crates/dns-enforcement/harness/blocky-env.sh down
//! ```
//!
//! Without `OPENSESAME_BLOCKY_API` set, each test prints why it did nothing and
//! returns. That is a gap in coverage and is reported as one — it is not a pass,
//! and nothing here substitutes a mock for the server. The one test that always
//! runs is [`a_bare_disable_is_unconstructible`], because the guarantee it checks
//! is structural rather than behavioural.

use std::env;
use std::path::PathBuf;

use opensesame_dns_enforcement::blocky::{DisableGroups, DisableWindow, Operation, ProtocolError};
use opensesame_dns_enforcement::scope::DomainRule;
use opensesame_dns_enforcement::transport::BlockyEndpoint;

/// The environment the harness exports.
struct Fixture {
    endpoint: BlockyEndpoint,
    allowlist: PathBuf,
    denied: String,
    group: String,
}

impl Fixture {
    /// Read the fixture, or explain why the test is not running.
    fn read(test: &str) -> Option<Self> {
        let Ok(api) = env::var("OPENSESAME_BLOCKY_API") else {
            eprintln!(
                "SKIP {test}: OPENSESAME_BLOCKY_API is unset, so no Blocky was measured. \
                 Run `crates/dns-enforcement/harness/blocky-env.sh up` first. \
                 This is missing coverage, not a passing protocol check."
            );
            return None;
        };
        let allowlist = env::var("OPENSESAME_BLOCKY_ALLOWLIST")
            .expect("OPENSESAME_BLOCKY_ALLOWLIST must accompany OPENSESAME_BLOCKY_API");
        let denied = env::var("OPENSESAME_BLOCKY_DENIED_NAME")
            .unwrap_or_else(|_| "both.example.org".to_owned());
        let group = env::var("OPENSESAME_BLOCKY_GROUP").unwrap_or_else(|_| "unit-alpha".to_owned());

        Some(Self {
            endpoint: BlockyEndpoint::new(&api).expect("harness endpoint should be valid"),
            allowlist: PathBuf::from(allowlist),
            denied,
            group,
        })
    }

    fn rule(&self) -> DomainRule {
        DomainRule::parse(&self.denied).expect("the denied name should be a usable rule")
    }

    /// Put the unit back to "nothing allowed", so tests do not depend on order.
    async fn reset(&self) {
        self.endpoint
            .apply_allowlist(&self.allowlist, &[])
            .await
            .expect("resetting the allowlist should succeed");
    }
}

#[tokio::test]
async fn a_bare_disable_is_unconstructible() {
    // Structural, so it runs with or without a server: the empty-groups request
    // that would disable every group cannot be built in the first place.
    let empty: Vec<String> = Vec::new();
    assert_eq!(
        DisableGroups::new(empty),
        Err(ProtocolError::DisableWithoutGroups)
    );

    // And no operation renders a disable without naming groups.
    let spec = Operation::Disable {
        groups: DisableGroups::new(["unit-alpha"]).expect("groups"),
        window: None,
    }
    .spec();
    assert!(spec
        .query
        .iter()
        .any(|(key, value)| key == "groups" && !value.is_empty()));
}

#[tokio::test]
async fn the_instance_is_reachable_and_enforcing() {
    let Some(fixture) = Fixture::read("the_instance_is_reachable_and_enforcing") else {
        return;
    };

    let status = fixture
        .endpoint
        .preflight()
        .await
        .expect("preflight should find an enforcing instance");
    assert!(status.enabled);
    assert!(status.disabled_groups.is_empty());
    assert!(!status.is_indefinitely_disabled());
}

#[tokio::test]
async fn a_denied_name_is_blocked_and_an_allowance_releases_it() {
    let Some(fixture) = Fixture::read("a_denied_name_is_blocked_and_an_allowance_releases_it")
    else {
        return;
    };
    fixture.reset().await;

    let blocked = fixture
        .endpoint
        .resolve(&fixture.denied, "A")
        .await
        .expect("query should succeed");
    assert!(
        blocked.is_blocked(),
        "{} should start blocked, got {:?}",
        fixture.denied,
        blocked
    );
    // Blocky names the group that refused it, which is how the test knows the
    // block came from this unit and not from somewhere else.
    let outcome = blocked.answered().expect("a block is an answered query");
    assert!(outcome.reason.contains(&fixture.group), "{outcome:?}");

    fixture
        .endpoint
        .apply_allowlist(&fixture.allowlist, &[fixture.rule()])
        .await
        .expect("applying the allowance should succeed");

    // The harness upstream is deliberately dead, so an admitted name comes back
    // as `AdmittedButUnresolved` — the filter let it through, which is the fact
    // under test. Reading that as a capability gap was a real bug here.
    let allowed = fixture
        .endpoint
        .resolve(&fixture.denied, "A")
        .await
        .expect("an admitted name must not read as an unavailable filter");
    assert!(
        !allowed.is_blocked(),
        "{} should be released by the allowance, got {:?}",
        fixture.denied,
        allowed
    );

    fixture.reset().await;
    let blocked_again = fixture
        .endpoint
        .resolve(&fixture.denied, "A")
        .await
        .expect("query should succeed");
    assert!(
        blocked_again.is_blocked(),
        "revoking should restore the block, got {blocked_again:?}"
    );
}

#[tokio::test]
async fn granting_a_domain_never_turns_the_filter_off() {
    let Some(fixture) = Fixture::read("granting_a_domain_never_turns_the_filter_off") else {
        return;
    };
    fixture.reset().await;

    // The regression this whole crate is shaped around: an allowance must not be
    // implemented as a disable, so blocking stays on across the entire grant.
    fixture
        .endpoint
        .apply_allowlist(&fixture.allowlist, &[fixture.rule()])
        .await
        .expect("applying the allowance should succeed");

    let during = fixture
        .endpoint
        .status()
        .await
        .expect("status should be readable");
    assert!(
        during.enabled,
        "blocking must stay on while a domain is allowed, got {during:?}"
    );
    assert!(
        during.disabled_groups.is_empty(),
        "no group may be disabled by an allowance, got {during:?}"
    );
    assert!(during.auto_enable_in_sec.is_none());

    // A name the unit denies and nobody allowed is still blocked during the
    // grant — the allowance released one name, not the list.
    let other = fixture
        .endpoint
        .resolve("blocked.example.org", "A")
        .await
        .expect("query should succeed");
    assert!(
        other.is_blocked(),
        "an unrelated denied name must stay blocked, got {other:?}"
    );

    fixture.reset().await;
}

#[tokio::test]
async fn a_scoped_disable_touches_only_its_group_and_re_enables_itself() {
    let Some(fixture) =
        Fixture::read("a_scoped_disable_touches_only_its_group_and_re_enables_itself")
    else {
        return;
    };

    let operation = Operation::Disable {
        groups: DisableGroups::new([fixture.group.clone()]).expect("groups"),
        window: Some(DisableWindow::seconds(30).expect("window")),
    };
    fixture
        .endpoint
        .send(&operation)
        .await
        .expect("a scoped disable should succeed");

    let disabled = fixture
        .endpoint
        .status()
        .await
        .expect("status should be readable");
    assert_eq!(disabled.disabled_groups, vec![fixture.group.clone()]);
    assert!(!disabled.enabled);
    // The one autonomous timer Blocky has, and the reason `ExpiryHolder`
    // distinguishes it from anything this crate issues.
    assert!(
        disabled.auto_enable_in_sec.is_some(),
        "a windowed disable should schedule its own re-enable, got {disabled:?}"
    );
    assert!(!disabled.is_indefinitely_disabled());

    // While disabled, preflight refuses rather than reporting health.
    let refusal = fixture
        .endpoint
        .preflight()
        .await
        .expect_err("preflight must refuse a disabled instance");
    assert!(refusal.is_capability_gap(), "{refusal}");

    fixture
        .endpoint
        .send(&Operation::Enable)
        .await
        .expect("enable should succeed");
    let restored = fixture
        .endpoint
        .preflight()
        .await
        .expect("the instance should be enforcing again");
    assert!(restored.enabled);
}

#[tokio::test]
async fn an_unknown_group_is_refused_and_leaves_blocking_alone() {
    let Some(fixture) = Fixture::read("an_unknown_group_is_refused_and_leaves_blocking_alone")
    else {
        return;
    };

    // Measured: Blocky answers 400 for a group it does not know, and does not
    // fall back to disabling everything.
    let operation = Operation::Disable {
        groups: DisableGroups::new(["unit-does-not-exist"]).expect("groups"),
        window: None,
    };
    let refusal = fixture
        .endpoint
        .send(&operation)
        .await
        .expect_err("an unknown group must be refused");
    assert!(refusal.is_capability_gap(), "{refusal}");

    let status = fixture
        .endpoint
        .preflight()
        .await
        .expect("blocking should be untouched by the refused request");
    assert!(status.enabled);
}
