use std::process::Command;

fn authorization_url_may_open_in_browser(url: &str) -> bool {
    let parsed = match url::Url::parse(url) {
        Ok(parsed) => parsed,
        Err(_) => return false,
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

fn windows_browser_command(url: &str) -> Command {
    // Pass the URL directly: a command shell would interpret OAuth query
    // separators as commands rather than browser arguments.
    let mut command = Command::new("explorer.exe");
    command.arg(url);
    command
}

pub(super) fn open_url(url: &str) {
    if !authorization_url_may_open_in_browser(url) {
        return;
    }
    let mut cmd = if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(url);
        command
    } else if cfg!(target_os = "windows") {
        windows_browser_command(url)
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };
    let _ = cmd.spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_oauth_query_is_one_browser_argument() {
        let url = "https://example.invalid/authorize?client_id=public&state=one&calc";
        let command = windows_browser_command(url);
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
}
