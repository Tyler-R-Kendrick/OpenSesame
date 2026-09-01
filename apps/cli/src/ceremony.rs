//! What connector registration this build can automate (ADR 0082 §7).
//!
//! This verb answers from the **compiled-in** catalog and makes no request. Two
//! reasons, and the second is the one that decided it:
//!
//! - A lookup is a disclosure (ADR 0052 §12). Asking a server which ceremony
//!   covers `provider-x` tells that server which provider is being onboarded,
//!   and the catalog is checked in so nobody has to answer that.
//! - It has to work before there is a Host. Registering a GitHub App is how a
//!   deployment gets its backup target working in the first place; a verb that
//!   needed a running gateway to explain how to set the gateway up would be a
//!   bootstrap loop. `opensesame ceremony list` works on a laptop with nothing
//!   configured, which is exactly where it is read.
//!
//! `apps/gateway/src/routes/ceremonies.rs` serves the same data to clients that
//! cannot compile the crate in. Both read `crates/ceremony/catalog.json`, so
//! they cannot drift.

use std::fmt::Write as _;

use anyhow::Result;
use opensesame_ceremony::{Catalog, CatalogEntry, Phase, Tier};
use serde_json::json;

/// Width of one tier column. `c0_provider_native` is the longest name the
/// ladder has, and a column narrower than it runs the rows together.
const TIER_COLUMN: usize = 20;

/// Width of the phase column in `show`, sized the same way.
const PHASE_COLUMN: usize = 16;

/// One table row: every cell padded to a tier column, trailing space trimmed.
///
/// Writing into a `String` cannot fail, so the results are dropped rather than
/// propagated — a `Result` here would be an error nobody can produce.
fn padded_row<'a>(cells: impl Iterator<Item = &'a str>) -> String {
    let mut row = String::new();
    for cell in cells {
        let _ = write!(row, "{cell:<TIER_COLUMN$}");
    }
    row.trim_end().to_string()
}

/// The one-word answer for a provider: is any of this automated?
fn coverage(entry: &CatalogEntry) -> &'static str {
    if !entry.is_runnable() {
        return "instructions";
    }
    if entry.plan().iter().all(|(_, tier)| *tier != Tier::Blocked) {
        return "full";
    }
    "partial"
}

/// `opensesame ceremony list` — every provider the catalog covers.
///
/// A provider that is not listed is not broken: every phase is C3, and it gets
/// the copy-paste instructions it has today (ADR 0082 alternatives). Saying so
/// out loud at the end of the table is the difference between "we do not
/// automate this" and "this is missing".
pub fn cmd_list(output: &str) -> Result<()> {
    let catalog = Catalog::load();
    if output == "json" {
        let entries: Vec<_> = catalog
            .entries()
            .iter()
            .map(|entry| {
                json!({
                    "provider_id": entry.provider_id,
                    "coverage": coverage(entry),
                    "runnable": entry.is_runnable(),
                    "declares": entry.declares,
                    "verifies_by": entry.verifies_by,
                    "note": entry.note,
                    "plan": entry
                        .plan()
                        .into_iter()
                        .map(|(phase, tier)| json!({
                            "phase": phase.as_str(),
                            "tier": tier.as_str(),
                        }))
                        .collect::<Vec<_>>(),
                })
            })
            .collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({"ceremonies": entries}))?
        );
        return Ok(());
    }

    println!(
        "{:<14} {:<13} {}",
        "PROVIDER",
        "COVERAGE",
        padded_row(Phase::ALL.iter().map(|phase| phase.as_str())),
    );
    for entry in catalog.entries() {
        println!(
            "{:<14} {:<13} {}",
            entry.provider_id,
            coverage(entry),
            padded_row(entry.plan().iter().map(|(_, tier)| tier.as_str())),
        );
    }
    println!();
    println!(
        "A provider that is not listed is not missing: it resolves to {} for",
        Tier::Blocked.as_str(),
    );
    println!("every phase and keeps the setup instructions it has today.");
    Ok(())
}

/// `opensesame ceremony show <provider>` — one provider, in full.
///
/// Reads the same compiled-in catalog. Naming a provider here discloses nothing
/// because nothing leaves the process.
pub fn cmd_show(output: &str, provider_id: &str) -> Result<()> {
    let catalog = Catalog::load();
    let Some(entry) = catalog.get(provider_id) else {
        if output == "json" {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "provider_id": provider_id,
                    "covered": false,
                    "plan": Phase::ALL
                        .map(|phase| json!({
                            "phase": phase.as_str(),
                            "tier": Tier::Blocked.as_str(),
                        }))
                        .to_vec(),
                }))?
            );
            return Ok(());
        }
        println!("No ceremony covers `{provider_id}`.");
        println!(
            "Every phase is {}, so setting it up stays a documented",
            Tier::Blocked.as_str()
        );
        println!("manual step — the same one it is today.");
        return Ok(());
    };

    if output == "json" {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "provider_id": entry.provider_id,
                "covered": true,
                "coverage": coverage(entry),
                "native_registration": entry.native_registration,
                "native_registration_note": entry.native_registration_note,
                "recipe": entry.recipe,
                "agentic_allowed": entry.agentic_allowed,
                "declares": entry.declares,
                "verifies_by": entry.verifies_by,
                "note": entry.note,
                "plan": entry
                    .plan()
                    .into_iter()
                    .map(|(phase, tier)| json!({
                        "phase": phase.as_str(),
                        "tier": tier.as_str(),
                        "uses_a_model": tier.uses_a_model(),
                        "requires_a_present_user": tier.requires_a_present_user(),
                    }))
                    .collect::<Vec<_>>(),
            }))?
        );
        return Ok(());
    }

    println!("{}", entry.provider_id);
    if let Some(note) = &entry.note {
        println!("  {note}");
    }
    println!();
    for (phase, tier) in entry.plan() {
        let how = if tier.uses_a_model() {
            " (a model drives, and you must be watching)"
        } else if tier.requires_a_present_user() {
            " (replayed from a checked-in recipe, and you must be watching)"
        } else if tier == Tier::Blocked {
            " (not automated — you do this step)"
        } else {
            " (the provider's own endpoint)"
        };
        println!(
            "  {:<PHASE_COLUMN$} {tier_name}{how}",
            phase.as_str(),
            tier_name = tier.as_str()
        );
    }
    if let Some(reason) = &entry.native_registration_note {
        println!();
        println!("  Registration endpoint: {reason}");
    }
    println!();
    // The capture slots are the interesting half: they are what the ceremony is
    // permitted to seal, and a person agreeing to run one deserves the list
    // before it runs rather than a receipt after (ADR 0082 §3).
    if entry.declares.is_empty() {
        println!("  Captures nothing.");
    } else {
        println!("  May capture: {}", entry.declares.join(", "));
        println!("  Nothing else can be captured, whatever the page offers.");
    }
    if let Some(proof) = &entry.verifies_by {
        println!("  Proved by: {proof}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tier_name_fits_its_column() {
        // The table ran together before this was widened: `c0_provider_native`
        // is 18 characters and the column was 16, so the GitHub row printed
        // `c0_provider_nativec3_blocked`. A width chosen by eye is a width that
        // breaks when the ladder gains a name, so it gets an assertion.
        for tier in Tier::ALL {
            assert!(
                tier.as_str().len() < TIER_COLUMN,
                "`{}` needs a wider TIER_COLUMN than {TIER_COLUMN}",
                tier.as_str(),
            );
        }
        for phase in Phase::ALL {
            assert!(
                phase.as_str().len() < TIER_COLUMN,
                "`{}` needs a wider TIER_COLUMN than {TIER_COLUMN}",
                phase.as_str(),
            );
            assert!(
                phase.as_str().len() < PHASE_COLUMN,
                "`{}` needs a wider PHASE_COLUMN than {PHASE_COLUMN}",
                phase.as_str(),
            );
        }
    }

    #[test]
    fn a_ceremony_that_runs_nothing_reads_as_instructions_rather_than_as_broken() {
        // ADR 0082's alternatives section: a ceremony that cannot run leaves
        // the user where they started. "instructions" says that; "none" or an
        // empty cell would read as a defect in a build that is behaving.
        let catalog = Catalog::load();
        for entry in catalog.entries() {
            let verdict = coverage(entry);
            assert_eq!(
                verdict == "instructions",
                !entry.is_runnable(),
                "{}: coverage `{verdict}` disagrees with is_runnable()",
                entry.provider_id,
            );
        }
    }

    #[test]
    fn github_is_partial_because_registering_is_not_installing() {
        // The distinction ADR 0082 §1 exists for. GitHub's manifest endpoint
        // covers registration and nothing else, so reporting "full" here would
        // be the "registered but never installed" failure told as a success.
        let catalog = Catalog::load();
        let github = catalog.get("github").expect("github is in the catalog");
        assert_eq!(coverage(github), "partial");
    }

    #[test]
    fn full_means_no_phase_is_left_to_the_user() {
        // No entry claims it yet, so this asserts the rule rather than the data
        // — it is the line the first fully covered provider has to clear.
        let catalog = Catalog::load();
        for entry in catalog.entries() {
            if coverage(entry) == "full" {
                assert!(
                    entry.plan().iter().all(|(_, tier)| *tier != Tier::Blocked),
                    "{}: reported full with a blocked phase",
                    entry.provider_id,
                );
            }
        }
    }
}
