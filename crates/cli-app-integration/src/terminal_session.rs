//! Derive a stable terminal session id from a kernel-attested peer pid (D4-2).

use sha2::{Digest, Sha256};

/// Hash of the process session id and controlling tty (Linux `stat` fields).
#[must_use]
pub fn stable_session_id(session_id: u64, tty_nr: u32) -> String {
    let tty_label = tty_nr.to_string();
    stable_session_key(session_id, &tty_label)
}

fn stable_session_key(session_id: u64, tty_label: &str) -> String {
    let payload = format!("{session_id}\0{tty_label}");
    let digest = Sha256::digest(payload.as_bytes());
    hex::encode(digest)[..32].to_string()
}

/// Read session + tty for a live pid. Linux uses `/proc`; macOS uses `ps`.
#[must_use]
pub fn session_id_from_pid(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        linux_session_id_from_pid(pid)
    }
    #[cfg(target_os = "macos")]
    {
        macos_session_id_from_pid(pid)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

#[cfg(target_os = "linux")]
fn linux_session_id_from_pid(pid: u32) -> Option<String> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (session_id, tty_nr) = parse_linux_proc_stat(&raw)?;
    Some(stable_session_id(session_id, tty_nr))
}

/// Parse `sid` and `tty_nr` from a `/proc/pid/stat` line (comm may contain spaces).
#[must_use]
pub fn parse_linux_proc_stat(raw: &str) -> Option<(u64, u32)> {
    let after_comm = raw.rsplit_once(')')?.1.trim();
    let fields: Vec<&str> = after_comm.split_whitespace().collect();
    if fields.len() < 5 {
        return None;
    }
    let session_id = fields[3].parse::<u64>().ok()?;
    let tty_nr = fields[4].parse::<u32>().ok()?;
    Some((session_id, tty_nr))
}

/// The variable that names the exact `ps` to run.
#[cfg(any(target_os = "macos", all(test, unix)))]
const PS_OVERRIDE: &str = "OPENSESAME_PS";

/// `ps`, found by the trusted rule or `OPENSESAME_PS`, handed `PATH` (the
/// trusted entries) and the common set only: it reads the process table, not
/// the environment, so none of this process's secrets go with it. When no `ps`
/// can be trusted the refusal says which variable names one.
#[cfg(any(target_os = "macos", all(test, unix)))]
fn ps_in(
    lookup: &opensesame_trusted_exec::Lookup,
) -> Result<std::process::Command, opensesame_trusted_exec::ResolveError> {
    opensesame_trusted_exec::command_in("ps", Some(PS_OVERRIDE), lookup)
}

/// Says once why `ps` was refused, so a session id that cannot be looked up
/// is not a silent failure.
#[cfg(target_os = "macos")]
fn say_ps_refused(error: &opensesame_trusted_exec::ResolveError) {
    static SAID: std::sync::Once = std::sync::Once::new();
    SAID.call_once(|| eprintln!("warning: the terminal session cannot be told apart: {error}"));
}

#[cfg(target_os = "macos")]
fn macos_session_id_from_pid(pid: u32) -> Option<String> {
    let mut ps = match ps_in(&opensesame_trusted_exec::Lookup::capture()) {
        Ok(ps) => ps,
        Err(error) => {
            say_ps_refused(&error);
            return None;
        }
    };
    let output = ps
        .args(["-p", &pid.to_string(), "-o", "sid=,tty="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let line = text.lines().next()?.trim();
    let (sid_raw, tty_raw) = line.split_once(char::is_whitespace)?;
    let session_id = sid_raw.trim().parse::<u64>().ok()?;
    Some(stable_session_key(session_id, tty_raw.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_linux_proc_stat_handles_comm_with_spaces() {
        let raw = "4242 (my bash (v2)) S 1 2 3 4 5 6 7 8 9 10";
        let (sid, tty) = parse_linux_proc_stat(raw).expect("parsed");
        assert_eq!(sid, 3);
        assert_eq!(tty, 4);
    }

    #[test]
    fn stable_session_id_is_deterministic() {
        let a = stable_session_id(99, 34816);
        let b = stable_session_id(99, 34816);
        assert_eq!(a, b);
        assert_ne!(a, stable_session_id(99, 34817));
    }

    #[cfg(unix)]
    #[test]
    fn ps_is_the_trusted_one_or_the_file_opensesame_ps_names() {
        use opensesame_trusted_exec::testkit::Fixture;
        let fixture = Fixture::new("ps");
        let mut ps = ps_in(&fixture.lookup(&[])).expect("trusted ps");
        assert!(ps.args(["-p", "1"]).status().unwrap().success());
        let _ = fixture.assert_clean();
        let chosen = fixture.scratch("chosen").join("ps");
        fixture.stub_recorder(&chosen);
        let value = chosen.display().to_string();
        let named = ps_in(&fixture.lookup(&[(PS_OVERRIDE, &value)])).unwrap();
        assert_eq!(named.get_program(), chosen.as_os_str());
        let refused = ps_in(&fixture.lookup(&[(PS_OVERRIDE, "ps")])).unwrap_err();
        assert!(
            refused
                .to_string()
                .starts_with("OPENSESAME_PS must be an absolute path"),
            "{refused}"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn session_id_from_own_pid() {
        let pid = std::process::id();
        let id = session_id_from_pid(pid).expect("own /proc/stat");
        assert_eq!(id.len(), 32);
    }
}
