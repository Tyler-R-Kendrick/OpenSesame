//! `opensesame hooks policy preset ls|show` and `put --preset` — named hook
//! policies as data (ADR 0159, ADR 0139).
//!
//! A preset is a file under `spec/agent-hooks/presets/`, embedded here and
//! in the gateway (`GET /api/v1/agent-hooks/presets`), each with a drift test
//! against the directory. Listing and showing need no Host: the table is
//! compiled in. `put --preset NAME` sends the preset's policy through the
//! ordinary compare-and-set replacement, so it meets the same parser and the
//! same step-up as a policy read from a file, and no second way to write a
//! policy exists.

use anyhow::{anyhow, bail, Context, Result};
use clap::Subcommand;
use opensesame_agent_hooks::{HookPolicy, SPEC_VERSION};
use serde::Deserialize;
use serde_json::{json, Value};

/// The files of `spec/agent-hooks/presets/`, by name. The drift test fails
/// when this table and the directory disagree.
const SOURCES: [(&str, &str); 3] = [
    (
        "observe",
        include_str!("../../../spec/agent-hooks/presets/observe.json"),
    ),
    (
        "rotation-web-login",
        include_str!("../../../spec/agent-hooks/presets/rotation-web-login.json"),
    ),
    (
        "strict",
        include_str!("../../../spec/agent-hooks/presets/strict.json"),
    ),
];

#[derive(Subcommand, Debug)]
pub enum PresetCmd {
    /// List the named policies, each with its summary.
    Ls,
    /// Print one preset: its summary and the policy `put --preset` would send.
    Show {
        /// The preset's name, as `ls` prints it.
        name: String,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    preset: u32,
    name: String,
    summary: String,
    policy: Value,
}

/// A preset, its policy parsed by the parser the Host uses.
#[derive(Debug)]
pub struct Preset {
    pub name: String,
    pub summary: String,
    pub policy: HookPolicy,
}

fn parse(expected: &str, source: &str) -> Result<Preset> {
    let envelope: Envelope = serde_json::from_str(source)
        .with_context(|| format!("preset {expected} is not a preset file"))?;
    if envelope.preset != 1 || envelope.name != expected {
        bail!("preset {expected} has an unsupported version or the wrong name");
    }
    let policy = HookPolicy::parse(&envelope.policy.to_string())
        .with_context(|| format!("preset {expected}"))?;
    Ok(Preset {
        name: envelope.name,
        summary: envelope.summary,
        policy,
    })
}

/// Every preset, by name.
pub fn all() -> Result<Vec<Preset>> {
    SOURCES
        .iter()
        .map(|(name, source)| parse(name, source))
        .collect()
}

/// The preset called `name`.
pub fn get(name: &str) -> Result<Preset> {
    let known = all()?;
    let names: Vec<&str> = known.iter().map(|preset| preset.name.as_str()).collect();
    let listed = names.join(", ");
    known
        .into_iter()
        .find(|preset| preset.name == name)
        .ok_or_else(|| anyhow!("no hook policy preset named `{name}`; the presets are: {listed}"))
}

fn view(preset: &Preset) -> Value {
    json!({
        "name": preset.name,
        "summary": preset.summary,
        "policy": preset.policy,
    })
}

/// `opensesame hooks policy preset …`.
pub fn run(cmd: &PresetCmd) -> Result<()> {
    let body = match cmd {
        PresetCmd::Ls => {
            let presets: Vec<Value> = all()?
                .iter()
                .map(|preset| json!({"name": preset.name, "summary": preset.summary}))
                .collect();
            json!({ "spec": SPEC_VERSION, "presets": presets })
        }
        PresetCmd::Show { name } => view(&get(name)?),
    };
    println!("{}", serde_json::to_string_pretty(&body)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    fn directory() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/agent-hooks/presets")
    }

    /// ADR 0139: the directory is the source, this table is an embedding of it.
    #[test]
    fn the_embedded_table_and_the_presets_directory_agree() {
        let mut on_disk = BTreeSet::new();
        for entry in std::fs::read_dir(directory()).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "json") {
                let stem = path.file_stem().unwrap().to_str().unwrap().to_owned();
                let text = std::fs::read_to_string(&path).unwrap();
                let embedded = SOURCES.iter().find(|(name, _)| *name == stem);
                assert_eq!(
                    embedded.map(|(_, source)| *source),
                    Some(text.as_str()),
                    "{stem}.json is missing from SOURCES or differs from it"
                );
                on_disk.insert(stem);
            }
        }
        let embedded: BTreeSet<String> =
            SOURCES.iter().map(|(name, _)| (*name).to_owned()).collect();
        assert_eq!(on_disk, embedded, "a preset file and the table disagree");
    }

    #[test]
    fn every_preset_is_a_policy_the_parser_reads_back_unchanged() {
        let presets = all().unwrap();
        assert_eq!(presets.len(), SOURCES.len());
        for preset in &presets {
            assert!(!preset.summary.is_empty(), "{}", preset.name);
            let text = serde_json::to_string(&preset.policy).unwrap();
            assert_eq!(HookPolicy::parse(&text).as_ref(), Ok(&preset.policy));
        }
    }

    #[test]
    fn the_rotation_preset_names_the_eleven_verbs_of_the_tool_boundary() {
        let policy = get("rotation-web-login").unwrap().policy;
        let named: BTreeSet<&str> = policy
            .tools
            .iter()
            .map(|rule| rule.name.as_deref().unwrap())
            .collect();
        let verbs = [
            "navigate",
            "wait_for",
            "fill_credential",
            "assert_present",
            "submit",
            "read_dom_redacted",
            "screenshot_redacted",
            "verify_login",
            "outstanding",
            "capture_credential",
            "capture_download",
        ];
        assert_eq!(named, verbs.into_iter().collect::<BTreeSet<_>>());
        assert_eq!(
            policy.unlisted_tools,
            opensesame_agent_hooks::ToolDecision::Deny
        );
    }

    #[test]
    fn an_unknown_preset_names_the_ones_that_exist() {
        let said = get("lenient").unwrap_err().to_string();
        assert!(said.contains("`lenient`"), "{said}");
        for name in ["observe", "rotation-web-login", "strict"] {
            assert!(said.contains(name), "{said}");
        }
    }

    #[test]
    fn a_malformed_preset_is_refused_by_name() {
        for source in [
            "{}",
            r#"{"preset":2,"name":"x","summary":"s","policy":{"version":1}}"#,
            r#"{"preset":1,"name":"y","summary":"s","policy":{"version":1}}"#,
            r#"{"preset":1,"name":"x","summary":"s","policy":{"version":7}}"#,
        ] {
            let said = format!("{:#}", parse("x", source).unwrap_err());
            assert!(said.starts_with("preset x"), "{said}");
        }
    }
}
