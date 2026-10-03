//! The registry of live runs: one listener, one CA, one proxy credential and a
//! set of surrogates each, over one shared ledger.
//!
//! One ledger across runs is deliberate. A surrogate copied out of one run and
//! presented through another run's proxy is recognised — and refused as
//! `surrogate.foreign_caller` — instead of reading as an unknown string; and
//! a run that has ended keeps its revoked entries, so a late use reads as
//! `surrogate.revoked`, a tripwire, rather than noise (ADR 0150 §3).

use std::collections::HashMap;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use opensesame_invoke_through::{IssueError, Surrogate, SurrogateSite, SurrogateSpec};
use opensesame_session_observe::{ControlLease, RunCredentials};
use secrecy::{ExposeSecret, SecretString};
use tokio::sync::{watch, Semaphore};
use tokio::task::JoinHandle;
use zeroize::Zeroizing;

use crate::auth::{random_entropy, random_hex, ProxyCredential};
use crate::ca::{CertError, RunCa};
use crate::config::{ProxyConfig, Shared};
use crate::env;
use crate::listener::{self, unpoison, RunContext};
use crate::login::{LoginError, LoginGrant, RunLogins};
use crate::target::normalize_host;
use crate::tripwire::{RunRevoker, RunWatch};

/// One surrogate a run's child receives, and the environment variable it
/// arrives in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SurrogateGrant {
    pub env_var: String,
    pub provider_id: String,
    /// The `conn://…` reference the brokered calls are receipted against.
    pub connection_ref: String,
    pub site: SurrogateSite,
    pub methods: Vec<String>,
    pub path_prefixes: Vec<String>,
    /// How long from issue the surrogate lives, run end aside.
    pub ttl: Duration,
}

/// What a run is given.
#[derive(Debug, Clone, Default)]
pub struct RunSpec {
    pub grants: Vec<SurrogateGrant>,
    /// Login forms the child signs in to with a surrogate (ADR 0150 §6.3).
    pub logins: Vec<LoginGrant>,
    /// Hosts whose un-surrogated requests are forwarded with no credential.
    /// Empty by default: un-surrogated traffic is refused.
    pub passthrough_hosts: Vec<String>,
    /// Whether someone is watching the run, so a `surrogate.misdirected`
    /// parks it and revokes what it holds (ADR 0150 §6.2).
    pub watched: bool,
}

/// Why a run could not start. Names no secret.
#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("a run id is required")]
    EmptyRunId,
    #[error("run `{0}` is already active")]
    AlreadyActive(String),
    #[error("`{0}` cannot carry a surrogate: reserved, repeated or not a variable name")]
    EnvVar(String),
    #[error("passthrough host `{0}` is not a host name")]
    PassthroughHost(String),
    #[error(transparent)]
    Issue(#[from] IssueError),
    #[error(transparent)]
    Login(#[from] LoginError),
    #[error(transparent)]
    Certificate(#[from] CertError),
    #[error("the run's listener could not start: {0}")]
    Listener(String),
}

/// What the embedder hands the child. `Debug` shows the run and the address,
/// never the proxy credential or a surrogate.
pub struct RunHandle {
    run_id: String,
    proxy_addr: SocketAddr,
    proxy_url: SecretString,
    ca_pem: String,
    surrogates: Vec<(String, Surrogate)>,
    logins: Vec<(String, Zeroizing<String>)>,
}

impl std::fmt::Debug for RunHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunHandle")
            .field("run_id", &self.run_id)
            .field("proxy_addr", &self.proxy_addr)
            .field("surrogates", &self.surrogates.len())
            .field("logins", &self.logins.len())
            .finish_non_exhaustive()
    }
}

impl RunHandle {
    #[must_use]
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// The listener's address, without the credential.
    #[must_use]
    pub fn proxy_addr(&self) -> SocketAddr {
        self.proxy_addr
    }

    /// `http://user:secret@127.0.0.1:port`, for the child's `HTTPS_PROXY`.
    #[must_use]
    pub fn proxy_url(&self) -> &SecretString {
        &self.proxy_url
    }

    /// The run CA's certificate, PEM, for the file the trust variables name.
    /// The certificate only: the key never leaves the proxy.
    #[must_use]
    pub fn ca_pem(&self) -> &str {
        &self.ca_pem
    }

    /// `(environment variable, surrogate)` per grant, in grant order.
    #[must_use]
    pub fn surrogates(&self) -> &[(String, Surrogate)] {
        &self.surrogates
    }

    /// The variables the run's login surrogates arrive in, in grant order.
    #[must_use]
    pub fn login_vars(&self) -> Vec<&str> {
        self.logins.iter().map(|(name, _)| name.as_str()).collect()
    }

    /// Everything the child's environment needs: the trust variables naming
    /// `ca_file` (which the caller writes from [`RunHandle::ca_pem`]), the
    /// proxy variables, `NO_PROXY`, and one variable per surrogate, API and
    /// login alike.
    #[must_use]
    pub fn child_env(&self, ca_file: &Path) -> Vec<(String, OsString)> {
        let mut vars = env::trust_and_proxy(ca_file, self.proxy_url.expose_secret());
        for (name, surrogate) in &self.surrogates {
            vars.push((name.clone(), OsString::from(surrogate.as_str())));
        }
        for (name, surrogate) in &self.logins {
            vars.push((name.clone(), OsString::from(surrogate.as_str())));
        }
        vars
    }
}

struct RunState {
    stop: watch::Sender<bool>,
    accept: JoinHandle<()>,
}

/// Live runs over one ledger.
pub struct SurrogateRuns {
    shared: Arc<Shared>,
    runs: Mutex<HashMap<String, RunState>>,
}

impl std::fmt::Debug for SurrogateRuns {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let runs = unpoison(self.runs.lock()).len();
        f.debug_struct("SurrogateRuns")
            .field("runs", &runs)
            .finish_non_exhaustive()
    }
}

impl SurrogateRuns {
    #[must_use]
    pub fn new(config: ProxyConfig) -> Self {
        Self {
            shared: Arc::new(Shared::new(config)),
            runs: Mutex::new(HashMap::new()),
        }
    }

    /// Start `run_id`: mint its CA, issue its surrogates from OS entropy, and
    /// open its listener on `127.0.0.1:0`. Must be called inside a Tokio
    /// runtime, which serves the listener.
    ///
    /// # Errors
    ///
    /// `EmptyRunId`, `AlreadyActive`, `EnvVar` (reserved, repeated or
    /// malformed), `PassthroughHost`, `Issue` (the ledger refused a grant;
    /// any already issued are revoked), `Certificate`, or `Listener` (no
    /// runtime, or the bind failed).
    pub fn create_run(&self, run_id: &str, spec: &RunSpec) -> Result<RunHandle, RunError> {
        if run_id.is_empty() {
            return Err(RunError::EmptyRunId);
        }
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|error| RunError::Listener(error.to_string()))?;
        let mut runs = unpoison(self.runs.lock());
        if runs.contains_key(run_id) {
            return Err(RunError::AlreadyActive(run_id.to_owned()));
        }
        check_env_vars(&spec.grants, &spec.logins)?;
        let passthrough_hosts = spec
            .passthrough_hosts
            .iter()
            .map(|host| normalize_host(host).ok_or_else(|| RunError::PassthroughHost(host.clone())))
            .collect::<Result<Vec<_>, _>>()?;
        let now = self.shared.config.clock.now_unix();
        let logins = RunLogins::arm(&spec.logins, self.shared.config.login_switch.as_ref())?;
        let ca = RunCa::mint(run_id, now, self.shared.config.ca_validity.as_secs())?;
        let listener = bind(&runtime)?;
        let proxy_addr = listener
            .local_addr()
            .map_err(|error| RunError::Listener(error.to_string()))?;
        let caller = format!("surrogate-proxy:{run_id}:{}", random_hex().as_str());
        let surrogates = self.issue(run_id, &caller, &spec.grants, now)?;
        let credential = ProxyCredential::generate();
        let proxy_url = credential.proxy_url(proxy_addr);
        let ca_pem = ca.cert_pem().to_owned();
        let login_surrogates = logins
            .as_ref()
            .map(|logins| logins.surrogates())
            .unwrap_or_default();
        if let Some(logins) = &logins {
            unpoison(self.shared.logins.lock()).insert(run_id.to_owned(), Arc::clone(logins));
        }
        unpoison(self.shared.watches.lock()).insert(run_id.to_owned(), RunWatch::new(spec.watched));
        let (stop, shutdown) = watch::channel(false);
        let ctx = Arc::new(RunContext {
            run_id: run_id.to_owned(),
            caller,
            credential,
            ca,
            passthrough_hosts,
            logins,
            acquisitions: Arc::new(Semaphore::new(
                self.shared.config.max_concurrent_acquisitions,
            )),
            shared: Arc::clone(&self.shared),
            shutdown,
        });
        let accept = runtime.spawn(listener::serve(listener, ctx));
        runs.insert(run_id.to_owned(), RunState { stop, accept });
        Ok(RunHandle {
            run_id: run_id.to_owned(),
            proxy_addr,
            proxy_url,
            ca_pem,
            surrogates,
            logins: login_surrogates,
        })
    }

    fn issue(
        &self,
        run_id: &str,
        caller: &str,
        grants: &[SurrogateGrant],
        now: u64,
    ) -> Result<Vec<(String, Surrogate)>, RunError> {
        let mut ledger = unpoison(self.shared.ledger.write());
        let mut issued = Vec::with_capacity(grants.len());
        for grant in grants {
            let spec = SurrogateSpec {
                provider_id: grant.provider_id.clone(),
                connection_ref: grant.connection_ref.clone(),
                run_id: run_id.to_owned(),
                caller: caller.to_owned(),
                site: grant.site.clone(),
                methods: grant.methods.clone(),
                path_prefixes: grant.path_prefixes.clone(),
                expires_at_unix: now.saturating_add(grant.ttl.as_secs()),
            };
            match ledger.issue(spec, random_entropy()) {
                Ok(surrogate) => issued.push((grant.env_var.clone(), surrogate)),
                Err(error) => {
                    ledger.revoke_run(run_id);
                    return Err(error.into());
                }
            }
        }
        Ok(issued)
    }

    /// End `run_id`: revoke every surrogate and login it was issued, stop
    /// its listener, and close its open tunnels. Returns how many were
    /// revoked. Revocation happens even for a run this registry no longer
    /// serves, so it is safe to call twice.
    pub fn end_run(&self, run_id: &str) -> usize {
        // The registry first, then the ledger. `create_run` holds the
        // registry while it issues, so taking it first waits for a run that
        // is starting to finish issuing; revoking afterwards then covers
        // everything it issued. Revoking first would count nothing, and the
        // surrogates issued a moment later would outlive their run.
        let state = unpoison(self.runs.lock()).remove(run_id);
        let revoked = self.credentials().revoke(run_id);
        unpoison(self.shared.watches.lock()).remove(run_id);
        unpoison(self.shared.logins.lock()).remove(run_id);
        if let Some(state) = state {
            let _ = state.stop.send(true);
            state.accept.abort();
        }
        revoked
    }

    /// What revokes a run and leaves its listener serving, so a late use is
    /// refused as revoked: the tripwire's [`RunCredentials`], for an embedder
    /// that parks a run itself.
    #[must_use]
    pub fn credentials(&self) -> RunRevoker {
        RunRevoker::new(Arc::clone(&self.shared))
    }

    /// Where `run_id`'s lease stands, while the run is live.
    #[must_use]
    pub fn lease(&self, run_id: &str) -> Option<ControlLease> {
        unpoison(self.shared.watches.lock())
            .get(run_id)
            .map(|watch| watch.lease)
    }

    /// Whether `run_id` is live.
    #[must_use]
    pub fn is_active(&self, run_id: &str) -> bool {
        unpoison(self.runs.lock()).contains_key(run_id)
    }
}

/// Ending is the registry's revocation: [`end_and_revoke`] over a
/// `SurrogateRuns` ends the run.
///
/// [`end_and_revoke`]: opensesame_session_observe::end_and_revoke
impl RunCredentials for SurrogateRuns {
    fn revoke(&self, run_id: &str) -> usize {
        self.end_run(run_id)
    }
}

impl Drop for SurrogateRuns {
    fn drop(&mut self) {
        for (_, state) in unpoison(self.runs.lock()).drain() {
            let _ = state.stop.send(true);
            state.accept.abort();
        }
    }
}

fn check_env_vars(grants: &[SurrogateGrant], logins: &[LoginGrant]) -> Result<(), RunError> {
    let mut seen: Vec<&str> = Vec::with_capacity(grants.len() + logins.len());
    let names = grants
        .iter()
        .map(|grant| grant.env_var.as_str())
        .chain(logins.iter().map(|login| login.env_var.as_str()));
    for name in names {
        if !env::is_valid_name(name) || env::is_reserved(name) || seen.contains(&name) {
            return Err(RunError::EnvVar(name.to_owned()));
        }
        seen.push(name);
    }
    Ok(())
}

fn bind(runtime: &tokio::runtime::Handle) -> Result<tokio::net::TcpListener, RunError> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| RunError::Listener(error.to_string()))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| RunError::Listener(error.to_string()))?;
    let _entered = runtime.enter();
    tokio::net::TcpListener::from_std(listener)
        .map_err(|error| RunError::Listener(error.to_string()))
}
