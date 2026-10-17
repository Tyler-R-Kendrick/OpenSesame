//! `tomb`: which file opens and closes a Linux Tomb, and what it is handed.
//!
//! `opensesame tomb open|close` runs from a shell that may hold the store's
//! password and the Host's keys. `tomb` is found by `opensesame-trusted-exec`'s
//! rule (`OPENSESAME_TOMB`, else a trusted `PATH` entry) and starts from
//! `PATH` (the trusted entries, where it finds `cryptsetup`, `sudo` and
//! `gpg`), `HOME`, `TMPDIR`, `LANG`, `LC_*` and the list below.

use std::process::Command;

use opensesame_trusted_exec::{command_in, pass_in, Lookup, Pass};

/// The variable that names the exact `tomb` to run.
const TOMB_OVERRIDE: &str = "OPENSESAME_TOMB";

/// What `tomb` is given besides `PATH` and the common set, each for one reason.
const TOMB_ENV: [Pass; 10] = [
    // A tomb key is sealed with gpg: its keyring and agent...
    Pass::Name("GNUPGHOME"),
    Pass::Name("GPG_AGENT_INFO"),
    // ...and the terminal or desktop its pinentry asks on.
    Pass::Name("GPG_TTY"),
    Pass::Name("TERM"),
    Pass::Name("DISPLAY"),
    Pass::Name("XAUTHORITY"),
    Pass::Name("WAYLAND_DISPLAY"),
    Pass::Name("XDG_RUNTIME_DIR"),
    Pass::Name("DBUS_SESSION_BUS_ADDRESS"),
    // The helper sudo asks with when mounting has no terminal.
    Pass::Name("SUDO_ASKPASS"),
];

/// `tomb` for `lookup`, ready for `open` or `close`.
fn tomb_in(lookup: &Lookup) -> anyhow::Result<Command> {
    let mut command = command_in("tomb", Some(TOMB_OVERRIDE), lookup).map_err(|why| {
        anyhow::anyhow!("{why}; install Tomb, name it with {TOMB_OVERRIDE}, or use a portable tomb")
    })?;
    pass_in(&mut command, &TOMB_ENV, lookup);
    Ok(command)
}

/// `tomb` for this process.
pub(super) fn tomb() -> anyhow::Result<Command> {
    tomb_in(&Lookup::capture())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use opensesame_trusted_exec::testkit::Fixture;

    #[test]
    fn tomb_is_the_trusted_one_and_is_handed_its_key_prompt_only() {
        let fixture = Fixture::new("tomb");
        let lookup = fixture.lookup(&[
            ("GNUPGHOME", "/home/dummy/.gnupg"),
            ("GPG_TTY", "/dev/pts/3"),
        ]);
        let mut tomb = tomb_in(&lookup).unwrap();
        assert!(tomb
            .args(["close", "/mnt/dummy"])
            .status()
            .unwrap()
            .success());
        let env = fixture.assert_clean();
        assert_eq!(env["GNUPGHOME"], "/home/dummy/.gnupg");
        assert_eq!(fixture.args().unwrap(), ["close", "/mnt/dummy"]);
    }

    #[test]
    fn opensesame_tomb_names_the_file_and_a_bad_value_is_said() {
        let fixture = Fixture::new("tomb");
        let chosen = fixture.scratch("chosen").join("tomb");
        fixture.stub_recorder(&chosen);
        let value = chosen.display().to_string();
        let named = tomb_in(&fixture.lookup(&[(TOMB_OVERRIDE, &value)])).unwrap();
        assert_eq!(named.get_program(), chosen.as_os_str());
        let err = tomb_in(&fixture.lookup(&[(TOMB_OVERRIDE, "tomb")]))
            .unwrap_err()
            .to_string();
        assert!(
            err.starts_with("OPENSESAME_TOMB must be an absolute path"),
            "{err}"
        );
    }
}
