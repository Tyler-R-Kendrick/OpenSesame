use std::process::Command;

use opensesame_trusted_exec::{command_in, pass_in, Lookup, Pass, Platform};

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

/// What Explorer needs on Windows beyond the common set: the profile folders.
const DESKTOP_ON_WINDOWS: [Pass; 2] = [Pass::Name("APPDATA"), Pass::Name("LOCALAPPDATA")];

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

/// The opener, found on a trusted `PATH` entry and handed [`DESKTOP`].
fn opener_in(lookup: &Lookup) -> Option<Command> {
    let mut command = command_in(opener_name(), None, lookup).ok()?;
    pass_in(&mut command, &DESKTOP, lookup);
    if lookup.platform == Platform::Windows {
        pass_in(&mut command, &DESKTOP_ON_WINDOWS, lookup);
    }
    Some(command)
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
    let Some(mut opener) = opener_in(&Lookup::capture()) else {
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
        let mut opener = opener_in(&lookup).expect("trusted opener");
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
}
