//! The opt-in local doctor: asks a provider's own CLI whether it is signed in,
//! without reading the user's disk. The CLI is found by the trusted rule and
//! handed only what it needs to answer (`opensesame-trusted-exec`).

use std::process::Command;

use opensesame_trusted_exec::{command_in, pass_in, Lookup, Pass, CA_BUNDLE, PROXY};

use super::summarize_cli_probe;

/// What `vercel` is given besides `PATH`, the common set, the proxy and the
/// CA bundle: where it keeps its login (`com.vercel.cli` under these).
const VERCEL_ENV: [Pass; 2] = [Pass::Name("XDG_DATA_HOME"), Pass::Name("XDG_CONFIG_HOME")];

/// `vercel`, found on a trusted `PATH` entry.
pub(super) fn vercel_in(lookup: &Lookup) -> anyhow::Result<Command> {
    let mut command = command_in("vercel", None, lookup)?;
    for allow in [&VERCEL_ENV[..], &PROXY, &CA_BUNDLE] {
        pass_in(&mut command, allow, lookup);
    }
    Ok(command)
}

/// One line on whether `service`'s CLI is signed in, when it can be asked.
pub(super) fn local_cli_status(service: &str) -> Option<String> {
    let lookup = Lookup::capture();
    let (bin, command, args): (&str, anyhow::Result<Command>, &[&str]) = match service {
        "github" => ("gh", crate::github::gh_in(&lookup), &["auth", "status"]),
        "vercel" => ("vercel", vercel_in(&lookup), &["whoami"]),
        _ => return None,
    };
    let output = command.ok()?.args(args).output().ok()?;
    Some(summarize_cli_probe(
        bin,
        output.status.success(),
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use opensesame_trusted_exec::testkit::Fixture;

    #[test]
    fn the_doctor_asks_the_trusted_vercel_and_hands_it_its_login_only() {
        let fixture = Fixture::new("vercel");
        let lookup = fixture.lookup(&[("XDG_DATA_HOME", "/home/dummy/.local/share")]);
        let mut command = vercel_in(&lookup).unwrap();
        assert!(command.arg("whoami").status().unwrap().success());
        let env = fixture.assert_clean();
        assert_eq!(env["XDG_DATA_HOME"], "/home/dummy/.local/share");
    }
}
