//! `git`: the one way this crate starts it, and everything it is handed.
//!
//! The store runs `git` from processes that may hold the store's password, the
//! Host's connection key and provider tokens. It is found by
//! `opensesame-trusted-exec`'s rule (`OPENSESAME_GIT`, else a trusted `PATH`
//! entry) and starts from an empty environment: `PATH` (the trusted entries,
//! where git finds `ssh` and its helpers), `HOME`, `TMPDIR`, `LANG`, `LC_*`,
//! and the list below. The parent's own `GIT_DIR`, `GIT_EXEC_PATH`,
//! `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_*`, `GIT_SSH_COMMAND`, `GIT_SSH` and
//! `GIT_ASKPASS` are not passed: they would point the store's git at another
//! repository, other programs or other configuration. What the store means
//! git to have (the push token in [`crate::GIT_TOKEN_ENV`]) it sets on the
//! command itself. An `ssh` command for a remote belongs in git's own
//! configuration (`core.sshCommand`), which git still reads.

use std::process::Command;

use opensesame_trusted_exec::{command_in, pass_in, Lookup, Pass, CA_BUNDLE, PROXY};

use crate::StoreError;

/// The variable that names the exact `git` to run.
pub(crate) const GIT_OVERRIDE: &str = "OPENSESAME_GIT";

/// What `git` is given of the parent's environment besides `PATH` and the
/// common set, each for one reason.
const GIT_ENV: [Pass; 6] = [
    // The person's git configuration: identity, credential helper, sshCommand.
    Pass::Name("XDG_CONFIG_HOME"),
    // Where `credential.helper=cache` keeps its socket.
    Pass::Name("XDG_CACHE_HOME"),
    // An ssh remote authenticates through the person's agent.
    Pass::Name("SSH_AUTH_SOCK"),
    // A `libsecret` credential helper reaches the keyring over the session bus.
    Pass::Name("DBUS_SESSION_BUS_ADDRESS"),
    Pass::Name("XDG_RUNTIME_DIR"),
    // The CA of a private forge, for an HTTPS remote.
    Pass::Name("GIT_SSL_CAINFO"),
];

/// `git` for this process.
pub(crate) fn git() -> Result<Command, StoreError> {
    git_in(&Lookup::capture())
}

/// `git` for `lookup`: found by the trusted rule, handed [`GIT_ENV`], the
/// proxy (a push reaches the network itself) and the CA bundle.
pub(crate) fn git_in(lookup: &Lookup) -> Result<Command, StoreError> {
    let mut command = command_in("git", Some(GIT_OVERRIDE), lookup)
        .map_err(|e| StoreError::Git(e.to_string()))?;
    for allow in [&GIT_ENV[..], &PROXY, &CA_BUNDLE] {
        pass_in(&mut command, allow, lookup);
    }
    Ok(command)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use opensesame_trusted_exec::testkit::Fixture;

    const CONFIGURED: [(&str, &str); 6] = [
        ("HTTPS_PROXY", "http://proxy.invalid:3128"),
        ("no_proxy", "localhost"),
        ("SSL_CERT_FILE", "/etc/ssl/dummy.pem"),
        ("GIT_SSL_CAINFO", "/etc/ssl/forge.pem"),
        ("SSH_AUTH_SOCK", "/run/dummy/agent.sock"),
        ("XDG_CONFIG_HOME", "/home/dummy/.config"),
    ];

    #[test]
    fn a_planted_git_never_runs_and_only_what_git_needs_reaches_it() {
        let fixture = Fixture::new("git");
        let mut extra = CONFIGURED.to_vec();
        extra.push(("GIT_SSH_COMMAND", "/planted/ssh"));
        extra.push(("GIT_ASKPASS", "/planted/askpass"));
        let mut command = git_in(&fixture.lookup(&extra)).unwrap();
        assert!(command.arg("status").status().unwrap().success());
        let env = fixture.assert_clean();
        for (name, value) in CONFIGURED {
            assert_eq!(env.get(name).map(String::as_str), Some(value), "{name}");
        }
        for name in ["GIT_SSH_COMMAND", "GIT_ASKPASS"] {
            assert!(!env.contains_key(name), "{name} reached git");
        }
        assert_eq!(fixture.args().unwrap(), ["status"]);
    }

    #[test]
    fn opensesame_git_names_the_exact_file() {
        let fixture = Fixture::new("git");
        let chosen = fixture.scratch("chosen").join("my-git");
        fixture.stub_recorder(&chosen);
        let value = chosen.display().to_string();
        let lookup = fixture.lookup(&[(GIT_OVERRIDE, &value)]);
        let mut command = git_in(&lookup).unwrap();
        assert_eq!(command.get_program(), chosen.as_os_str());
        assert!(command.status().unwrap().success());
        let env = fixture.assert_clean();
        assert!(!env.contains_key(GIT_OVERRIDE));
        let bad = fixture.lookup(&[(GIT_OVERRIDE, "git")]);
        let err = git_in(&bad).unwrap_err().to_string();
        assert!(
            err.contains("OPENSESAME_GIT must be an absolute path"),
            "{err}"
        );
    }
}
