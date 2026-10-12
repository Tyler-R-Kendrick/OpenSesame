//! A connection that carries its own credential (the token a deploy tool's
//! `conn://` reference names in the person's sealed store) is redeemed at the
//! last hop for the surrogate issued to it: per connection, not per provider,
//! and from nowhere else. On real sockets against a loopback TLS upstream.

mod support;

use std::sync::Arc;
use std::time::Duration;

use opensesame_invoke_through::{
    AuthStyle, EgressRule, Invoker, RefusalCode, SurrogateSite, TlsClientSpec,
};
use opensesame_surrogate_proxy::plugin::source::StaticCredential;
use opensesame_surrogate_proxy::{
    ConnectionSources, ProviderSources, ProxyConfig, RunHandle, RunSpec, SurrogateGrant,
    SurrogateRuns,
};
use secrecy::SecretString;
use support::client::{bearer, request, through_proxy};
use support::stub::{spawn_upstream, Upstream};
use support::{Receipts, Refusals, EVIL};

const API: &str = "api.vercel.test";
const TEAM_A: &str = "CANARY-vercel-team-a-9c1e-never-in-the-child";
const TEAM_B: &str = "CANARY-vercel-team-b-47d2-never-in-the-child";

struct World {
    upstream: Upstream,
    runs: SurrogateRuns,
    refusals: Arc<Refusals>,
    receipts: Arc<Receipts>,
}

fn grant(env_var: &str, connection_ref: &str) -> SurrogateGrant {
    SurrogateGrant {
        env_var: env_var.into(),
        provider_id: "vercel".into(),
        connection_ref: connection_ref.into(),
        site: SurrogateSite::Authorization,
        methods: vec!["GET".into()],
        path_prefixes: vec!["/v2/user".into(), "/reflect".into()],
        ttl: Duration::from_secs(600),
    }
}

fn source(secret: &str) -> Arc<StaticCredential> {
    Arc::new(StaticCredential::new(SecretString::from(secret.to_owned())))
}

/// A broker for `vercel` at a loopback host, drawing team A's and team B's
/// credentials from their connections and nothing from the provider.
async fn world(sources: ConnectionSources) -> World {
    let upstream = spawn_upstream(API).await;
    let invoker = Invoker::with_tls(
        vec![EgressRule {
            provider_id: "vercel",
            scheme: "https",
            hosts: &[API],
            auth: AuthStyle::Bearer,
        }],
        &TlsClientSpec {
            config: Arc::new(upstream.client_config()),
            server_name: None,
            pinned: Some((API.into(), vec![upstream.addr])),
        },
    );
    let refusals = Arc::new(Refusals::default());
    let receipts = Arc::new(Receipts::default());
    let config = ProxyConfig::new(Arc::new(invoker), Arc::new(sources), refusals.clone())
        .with_receipts(receipts.clone());
    World {
        upstream,
        runs: SurrogateRuns::new(config),
        refusals,
        receipts,
    }
}

fn two_teams() -> ConnectionSources {
    ConnectionSources::new(ProviderSources::new())
        .with_connection("conn://acme/team-a/vercel", source(TEAM_A))
        .with_connection("conn://acme/team-b/vercel", source(TEAM_B))
}

fn start(world: &World, run_id: &str, grants: Vec<SurrogateGrant>) -> RunHandle {
    world
        .runs
        .create_run(
            run_id,
            &RunSpec {
                grants,
                ..RunSpec::default()
            },
        )
        .expect("run starts")
}

fn surrogate_of(run: &RunHandle, env_var: &str) -> String {
    run.surrogates()
        .iter()
        .find(|(name, _)| name == env_var)
        .map(|(_, surrogate)| surrogate.as_str().to_owned())
        .expect("surrogate for env var")
}

#[tokio::test]
async fn each_connection_is_redeemed_for_its_own_credential() {
    let w = world(two_teams()).await;
    let run = start(
        &w,
        "run-two-teams",
        vec![
            grant("VERCEL_TOKEN_A", "conn://acme/team-a/vercel"),
            grant("VERCEL_TOKEN_B", "conn://acme/team-b/vercel"),
        ],
    );
    let env = run.child_env(std::path::Path::new("/tmp/run-ca.pem"));
    for (_, value) in &env {
        let value = value.to_string_lossy();
        assert!(
            !value.contains(TEAM_A) && !value.contains(TEAM_B),
            "{value}"
        );
    }
    for (env_var, canary) in [("VERCEL_TOKEN_A", TEAM_A), ("VERCEL_TOKEN_B", TEAM_B)] {
        let auth = format!("Bearer {}", surrogate_of(&run, env_var));
        let seen = through_proxy(
            &run,
            API,
            request("GET", API, "/v2/user", &[("authorization", &auth)]),
        )
        .await
        .expect("brokered");
        assert_eq!(seen.status, 200, "{env_var}");
        let hits = w.upstream.hits();
        assert_eq!(
            hits.last().unwrap().authorization.as_deref(),
            Some(&*format!("Bearer {canary}")),
            "{env_var} redeems its own connection's credential"
        );
    }
    let hits = w.upstream.hits();
    assert_eq!(hits.len(), 2);
    for hit in &hits {
        // The surrogate is a selector: it is never on the upstream's wire.
        assert!(
            hit.all_values.iter().all(|v| !v.contains("osr_")),
            "{hit:?}"
        );
    }
    let receipts = w.receipts.0.lock().unwrap();
    let refs: Vec<&str> = receipts
        .iter()
        .map(|(admission, _)| admission.connection_ref.as_str())
        .collect();
    assert_eq!(
        refs,
        vec!["conn://acme/team-a/vercel", "conn://acme/team-b/vercel"]
    );
    assert!(w.refusals.codes().is_empty());
}

#[tokio::test]
async fn a_connection_with_neither_a_credential_nor_a_tool_is_never_forwarded() {
    let sources = ConnectionSources::new(ProviderSources::new())
        .with_connection("conn://acme/team-a/vercel", source(TEAM_A));
    let w = world(sources).await;
    let run = start(
        &w,
        "run-no-source",
        vec![grant("VERCEL_TOKEN_B", "conn://acme/team-b/vercel")],
    );
    let auth = bearer(&run);
    let seen = through_proxy(
        &run,
        API,
        request("GET", API, "/v2/user", &[("authorization", &auth)]),
    )
    .await
    .expect("answered");
    assert_eq!(seen.status, 502);
    // Team A's credential is not a fallback for team B's connection.
    assert!(w.upstream.hits().is_empty());
    assert!(!seen.body.contains(TEAM_A) && !seen.body.contains(TEAM_B));
}

#[tokio::test]
async fn a_reflected_connection_credential_comes_back_scrubbed() {
    let w = world(two_teams()).await;
    let run = start(
        &w,
        "run-reflect",
        vec![grant("VERCEL_TOKEN_A", "conn://acme/team-a/vercel")],
    );
    let auth = bearer(&run);
    let seen = through_proxy(
        &run,
        API,
        request("GET", API, "/reflect", &[("authorization", &auth)]),
    )
    .await
    .expect("brokered");
    assert_eq!(seen.status, 200);
    assert!(!seen.body.contains(TEAM_A), "{}", seen.body);
    assert!(seen.body.contains("[redacted:credential]"));
    assert!(w.receipts.0.lock().unwrap()[0].1.credential_reflected);
}

#[tokio::test]
async fn the_credential_is_not_spent_on_a_misdirected_surrogate_or_after_the_run() {
    let w = world(two_teams()).await;
    let run = start(
        &w,
        "run-refuse",
        vec![grant("VERCEL_TOKEN_A", "conn://acme/team-a/vercel")],
    );
    let auth = bearer(&run);
    let seen = through_proxy(
        &run,
        EVIL,
        request("GET", EVIL, "/v2/user", &[("authorization", &auth)]),
    )
    .await
    .expect("the proxy terminates the host and refuses the request");
    assert_eq!(seen.status, 403);
    assert!(w.upstream.hits().is_empty());
    assert_eq!(w.refusals.codes(), vec![RefusalCode::Misdirected]);

    // A run's end revokes what it issued and stops its listener. Its
    // surrogate, carried to a live run, is a tripwire, not noise, and a
    // surrogate presented through another run's proxy is a foreign caller.
    let live = start(
        &w,
        "run-live",
        vec![grant("VERCEL_TOKEN_B", "conn://acme/team-b/vercel")],
    );
    assert_eq!(w.runs.end_run("run-refuse"), 1);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(tokio::net::TcpStream::connect(run.proxy_addr())
        .await
        .is_err());
    let late = through_proxy(
        &live,
        API,
        request("GET", API, "/v2/user", &[("authorization", &auth)]),
    )
    .await
    .expect("the live run answers");
    assert_eq!(late.status, 403);
    assert_eq!(
        w.refusals.codes(),
        vec![RefusalCode::Misdirected, RefusalCode::Revoked]
    );
    assert!(w.upstream.hits().is_empty(), "nothing was ever sent");
}
