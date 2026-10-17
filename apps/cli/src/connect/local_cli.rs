//! The opt-in local doctor: asks a provider's own CLI whether it is signed in,
//! without reading the user's disk. The CLI is found by the trusted rule and
//! handed only what it needs to answer (`opensesame-trusted-exec`).

use std::process::Command;

use opensesame_trusted_exec::{
    command_in, pass_in, Lookup, Pass, CA_BUNDLE, PROXY, VERSION_MANAGERS,
};

use super::summarize_cli_probe;

/// What `vercel` is given besides `PATH`, the common set, the proxy and the
/// CA bundle: where it keeps its login (`com.vercel.cli` under these).
const VERCEL_ENV: [Pass; 2] = [Pass::Name("XDG_DATA_HOME"), Pass::Name("XDG_CONFIG_HOME")];

/// `vercel`, found on a trusted `PATH` entry.
pub(super) fn vercel_in(lookup: &Lookup) -> anyhow::Result<Command> {
    let mut command = command_in("vercel", None, lookup)?;
    for allow in [&VERCEL_ENV[..], &VERSION_MANAGERS, &PROXY, &CA_BUNDLE] {
        pass_in(&mut command, allow, lookup);
    }
    Ok(command)
}

/// One line on whether `service`'s CLI is signed in, when it can be asked.
pub(super) fn local_cli_status(service: &str) -> Option<String> {
    local_cli_status_in(&Lookup::capture(), service)
}

fn local_cli_status_in(lookup: &Lookup, service: &str) -> Option<String> {
    let (bin, command, args): (&str, anyhow::Result<Command>, &[&str]) = match service {
        "github" => ("gh", crate::github::gh_in(lookup), &["auth", "status"]),
        "vercel" => ("vercel", vercel_in(lookup), &["whoami"]),
        _ => return None,
    };
    let mut command = match command {
        Ok(command) => command,
        Err(why) => return Some(format!("{bin}: not run ({why:#})")),
    };
    let output = command.args(args).output().ok()?;
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
    fn a_cli_the_doctor_cannot_run_is_said_not_left_out() {
        let fixture = Fixture::new("vercel");
        std::fs::remove_file(fixture.trusted.join("vercel")).unwrap();
        let line = local_cli_status_in(&fixture.lookup(&[]), "vercel").expect("a line, not none");
        assert!(line.starts_with("vercel: not run"), "{line}");
        assert!(line.contains("no usable `vercel`"), "{line}");
    }

    #[test]
    fn the_doctor_asks_the_trusted_vercel_and_hands_it_its_login_only() {
        let fixture = Fixture::new("vercel");
        let lookup = fixture.lookup(&[
            ("XDG_DATA_HOME", "/home/dummy/.local/share"),
            ("VOLTA_HOME", "/home/dummy/.volta"),
        ]);
        let mut command = vercel_in(&lookup).unwrap();
        assert!(command.arg("whoami").status().unwrap().success());
        let env = fixture.assert_clean();
        assert_eq!(env["XDG_DATA_HOME"], "/home/dummy/.local/share");
        assert_eq!(env["VOLTA_HOME"], "/home/dummy/.volta");
    }
}
