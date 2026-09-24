//! Programs this binary answers as under another name.
//!
//! git, Docker, the AWS SDK, kubectl and browsers each launch a helper by a
//! fixed executable name. Every one of those names is a link to `opensesame`
//! (`opensesame helpers link`), and the name it was started under picks the
//! program — one binary, one build, one release (ADR 0138 §6). Each helper
//! still runs in its own short-lived process, because the caller spawns it.
use clap::Subcommand;
use std::path::{Path, PathBuf};

/// Every name `opensesame` answers to besides its own, and whether this build
/// includes it. Password-manager bridges are off unless built in (ADR 0053).
pub const HELPERS: [(&str, bool); 7] = [
    ("git-credential-opensesame", true),
    ("docker-credential-opensesame", true),
    ("opensesame-credential-process", true),
    ("opensesame-kube-exec", true),
    ("opensesame-browserpass-host", cfg!(feature = "browserpass")),
    ("opensesame-gopass-jsonapi", cfg!(feature = "gopass")),
    ("opensesame-keepassxc-bridge", cfg!(feature = "keepassxc")),
];

/// `opensesame helpers`.
#[derive(Subcommand, Debug)]
pub enum HelpersCmd {
    /// Create each helper name as a link to this binary.
    Link {
        /// Where to create the links; defaults to this binary's directory.
        #[arg(long)]
        dir: Option<PathBuf>,
    },
    /// Run a helper by name, as if started under that name.
    #[command(hide = true)]
    Run {
        name: String,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
}

/// The helper exit code when this process was started under a helper's
/// name, `None` when it was started as `opensesame`.
pub fn by_program_name() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let name = Path::new(args.first()?).file_stem()?.to_str()?.to_owned();
    run(&name, &args[1..])
}

pub fn helpers(cmd: HelpersCmd) -> anyhow::Result<()> {
    match cmd {
        HelpersCmd::Link { dir } => link(dir),
        HelpersCmd::Run { name, args } => match run(&name, &args) {
            Some(code) => std::process::exit(code),
            None => anyhow::bail!("unknown helper `{name}`"),
        },
    }
}

fn run(name: &str, args: &[String]) -> Option<i32> {
    use opensesame_credential_helpers::entry;
    match name {
        "git-credential-opensesame" => entry::git::main(args),
        "docker-credential-opensesame" => entry::docker::main(args),
        "opensesame-credential-process" => entry::aws::main(),
        "opensesame-kube-exec" => entry::kube::main(),
        "opensesame-browserpass-host" => return Some(browserpass()),
        "opensesame-gopass-jsonapi" => return Some(gopass()),
        "opensesame-keepassxc-bridge" => return Some(keepassxc(args)),
        _ => return None,
    }
    Some(0)
}

#[cfg(feature = "browserpass")]
fn browserpass() -> i32 {
    opensesame_pm_bridges::entry::browserpass::main();
    0
}

#[cfg(not(feature = "browserpass"))]
fn browserpass() -> i32 {
    not_built("browserpass")
}

#[cfg(feature = "gopass")]
fn gopass() -> i32 {
    opensesame_pm_bridges::entry::gopass::main();
    0
}

#[cfg(not(feature = "gopass"))]
fn gopass() -> i32 {
    not_built("gopass")
}

#[cfg(feature = "keepassxc")]
fn keepassxc(args: &[String]) -> i32 {
    opensesame_pm_bridges::entry::keepassxc::main(args);
    0
}

#[cfg(not(feature = "keepassxc"))]
fn keepassxc(_args: &[String]) -> i32 {
    not_built("keepassxc")
}

#[cfg(not(all(feature = "browserpass", feature = "gopass", feature = "keepassxc")))]
fn not_built(feature: &str) -> i32 {
    eprintln!("opensesame: this build has no {feature} bridge (cargo feature `{feature}`)");
    2
}

fn link(dir: Option<PathBuf>) -> anyhow::Result<()> {
    let exe = std::env::current_exe()?;
    let dir = match dir {
        Some(dir) => dir,
        None => exe
            .parent()
            .ok_or_else(|| anyhow::anyhow!("cannot locate this binary's directory"))?
            .to_path_buf(),
    };
    std::fs::create_dir_all(&dir)?;
    for (name, built) in HELPERS {
        if !built {
            continue;
        }
        let path = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
        let _ = std::fs::remove_file(&path);
        link_to(&exe, &path)?;
        println!("{}", path.display());
    }
    Ok(())
}

#[cfg(unix)]
fn link_to(exe: &Path, path: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(exe, path)
}

#[cfg(not(unix))]
fn link_to(exe: &Path, path: &Path) -> std::io::Result<()> {
    std::fs::hard_link(exe, path).or_else(|_| std::fs::copy(exe, path).map(|_| ()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_helper_names_are_claimed() {
        assert_eq!(run("opensesame", &[]), None);
        assert_eq!(run("git-credential-other", &[]), None);
    }

    #[test]
    fn every_listed_helper_is_dispatched() {
        let source = include_str!("entry.rs");
        for (name, _) in HELPERS {
            assert!(
                source.matches(&format!("\"{name}\" =>")).count() == 1,
                "{name} has no dispatch arm"
            );
        }
    }
}
