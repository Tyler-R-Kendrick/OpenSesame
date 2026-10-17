use std::path::{Path, PathBuf};
use std::process::Command;

use opensesame_trusted_exec::{command_at, command_in, pass_in, Lookup, Pass, WSL};

/// What a browser opener is given besides `PATH` (the trusted entries) and the
/// common set: the desktop session it opens a window in, and the browser the
/// person chose. None of this process's secrets go with it.
const DESKTOP: [Pass; 6] = [
    Pass::Name("DISPLAY"),
    Pass::Name("WAYLAND_DISPLAY"),
    Pass::Name("XAUTHORITY"),
    Pass::Name("DBUS_SESSION_BUS_ADDRESS"),
    // The desktop's directories and session type, which xdg-open reads.
    Pass::Prefix("XDG_"),
    Pass::Name("BROWSER"),
];

/// Windows' own opener on WSL, which has no `xdg-open` of its own to rely on:
/// a fixed path this code chose, since WSL's `PATH` entries on the Windows
/// drive are writable by everyone and so never trusted.
const WSL_EXPLORER: &str = "/mnt/c/Windows/explorer.exe";

fn authorization_url_may_open_in_browser(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    match parsed.scheme() {
        "https" => true,
        "http" if is_nonproduction_loopback(&parsed) => true,
        _ => false,
    }
}

fn is_nonproduction_loopback(url: &url::Url) -> bool {
    let host = url.host_str().unwrap_or_default();
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
        && !std::env::var("OPENSESAME_ENV")
            .map(|value| value.eq_ignore_ascii_case("production"))
            .unwrap_or(false)
        && !std::env::var("NODE_ENV")
            .map(|value| value.eq_ignore_ascii_case("production"))
            .unwrap_or(false)
}

/// The program that opens a URL in the person's browser here.
const fn opener_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer.exe"
    } else {
        "xdg-open"
    }
}

/// The opener, found on a trusted `PATH` entry and handed [`DESKTOP`] and, for
/// a program that reaches Windows, the WSL interop variables. With none on
/// `PATH`, `wsl_explorer` (Windows' own, from [`wsl_explorer`]) opens the page.
fn opener_in(lookup: &Lookup, wsl_explorer: Option<&Path>) -> Option<Command> {
    let mut command = match command_in(opener_name(), None, lookup) {
        Ok(command) => command,
        Err(_) => command_at(wsl_explorer?, lookup).ok()?,
    };
    pass_in(&mut command, &DESKTOP, lookup);
    pass_in(&mut command, &WSL, lookup);
    Some(command)
}

/// Windows' `explorer.exe` seen from WSL, when this is WSL and it is there.
fn wsl_explorer() -> Option<PathBuf> {
    let on_wsl = std::fs::read_to_string("/proc/version")
        .is_ok_and(|version| version.to_ascii_lowercase().contains("microsoft"));
    let path = PathBuf::from(WSL_EXPLORER);
    (on_wsl && path.is_file()).then_some(path)
}

fn windows_browser_command(mut explorer: Command, url: &str) -> Command {
    // Pass the URL directly: a command shell would interpret OAuth query
    // separators as commands rather than browser arguments.
    explorer.arg(url);
    explorer
}

pub(super) fn open_url(url: &str) {
    if !authorization_url_may_open_in_browser(url) {
        return;
    }
    let Some(mut opener) = opener_in(&Lookup::capture(), wsl_explorer().as_deref()) else {
        return;
    };
    let mut cmd = if cfg!(target_os = "windows") {
        windows_browser_command(opener, url)
    } else {
        opener.arg(url);
        opener
    };
    let _ = cmd.spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_oauth_query_is_one_browser_argument() {
        let url = "https://example.invalid/authorize?client_id=public&state=one&calc";
        let command = windows_browser_command(Command::new("explorer.exe"), url);
        assert_eq!(command.get_program(), "explorer.exe");
        assert_eq!(command.get_args().collect::<Vec<_>>(), [url]);
    }

    #[test]
    fn authorization_urls_must_be_https_or_dev_loopback() {
        assert!(authorization_url_may_open_in_browser(
            "https://example.invalid/authorize?response_type=code&client_id=dummy"
        ));
        assert!(!authorization_url_may_open_in_browser(
            "javascript:alert(1)"
        ));
        assert!(!authorization_url_may_open_in_browser("file:///etc/passwd"));
    }

    #[cfg(unix)]
    #[test]
    fn the_opener_is_the_trusted_one_and_is_handed_the_desktop_only() {
        use opensesame_trusted_exec::testkit::Fixture;
        let fixture = Fixture::new(opener_name());
        let lookup = fixture.lookup(&[
            ("DISPLAY", ":0"),
            ("XDG_RUNTIME_DIR", "/run/user/1000"),
            ("GITHUB_TOKEN", "vtok_dummy_github_0123456789abcdef"),
        ]);
        let mut opener = opener_in(&lookup, None).expect("trusted opener");
        assert!(opener
            .arg("https://example.invalid/")
            .status()
            .unwrap()
            .success());
        let env = fixture.assert_clean();
        assert_eq!(env["DISPLAY"], ":0");
        assert_eq!(env["XDG_RUNTIME_DIR"], "/run/user/1000");
        assert!(!env.contains_key("GITHUB_TOKEN"), "{env:?}");
    }

    #[cfg(unix)]
    #[test]
    fn on_wsl_with_no_opener_of_its_own_windows_explorer_opens_the_page() {
        use opensesame_trusted_exec::testkit::Fixture;
        let fixture = Fixture::new("other");
        let explorer = fixture.scratch("c").join("explorer.exe");
        fixture.stub_recorder(&explorer);
        let lookup = fixture.lookup(&[("WSL_INTEROP", "/run/WSL/1_interop")]);
        let mut opener = opener_in(&lookup, Some(&explorer)).expect("explorer as the fallback");
        assert_eq!(opener.get_program(), explorer.as_os_str());
        assert!(opener
            .arg("https://example.invalid/")
            .status()
            .unwrap()
            .success());
        let env = fixture.assert_clean();
        assert_eq!(env["WSL_INTEROP"], "/run/WSL/1_interop");
        // An opener of its own wins, and still hears of the interop socket.
        let own = Fixture::new(opener_name());
        let lookup = own.lookup(&[("WSL_INTEROP", "/run/WSL/1_interop")]);
        let opener = opener_in(&lookup, Some(&explorer)).expect("trusted opener");
        assert_eq!(opener.get_program(), own.trusted.join(opener_name()));
        assert!(opener.get_envs().any(|(name, _)| name == "WSL_INTEROP"));
    }
}
