//! The worked example in `docs/operators/web-login-recipes.md`, run line by
//! line through the real binary (ADR 0076 §4, ADR 0159), against the example
//! recipe file the document embeds. The example is fully local: `signer
//! keygen` and `recipe sign` read and write files and talk to no Host.

mod hooks_mock;

use hooks_mock::opensesame;
use opensesame_rotation_web::recipe_doc::{parse_public_key_hex, RecipeDocument};
use serde_json::Value;

const DOC: &str = include_str!("../../../docs/operators/web-login-recipes.md");
const EXAMPLE: &str =
    include_str!("../../../docs/operators/examples/web-login-recipe.example.json");

/// The commands of the document's worked example, in order.
fn documented_commands() -> Vec<Vec<String>> {
    let section = DOC
        .split("## A worked example")
        .nth(1)
        .expect("the worked example");
    let block = section
        .split("```bash\n")
        .nth(1)
        .and_then(|rest| rest.split("```").next())
        .expect("a bash block");
    block
        .lines()
        .map(|line| {
            line.split_whitespace()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|words| !words.is_empty())
        .collect()
}

#[test]
fn the_document_embeds_the_example_recipe_it_runs() {
    let file: Value = serde_json::from_str(EXAMPLE).unwrap();
    let fenced = DOC
        .split("```json\n")
        .nth(1)
        .and_then(|rest| rest.split("```").next())
        .expect("a json block");
    assert_eq!(serde_json::from_str::<Value>(fenced).unwrap(), file);
    assert_eq!(
        fenced.trim(),
        EXAMPLE.trim(),
        "verbatim, not merely equivalent"
    );
    RecipeDocument::parse(EXAMPLE.as_bytes()).expect("the example is a valid recipe");
}

#[test]
fn every_command_in_the_document_is_a_real_verb() {
    let dir = tempfile::tempdir().unwrap();
    let mut verbs = 0;
    for line in DOC.lines().filter(|l| l.starts_with("opensesame rotate ")) {
        let words: Vec<&str> = line.split_whitespace().skip(2).collect();
        let (noun, verb) = (words[0], words[1]);
        assert!(matches!(noun, "recipe" | "signer"), "{line}");
        let out = opensesame(dir.path())
            .args(["rotate", noun, verb, "--help"])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{line}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        // Every flag the document uses is one the verb has.
        let help = String::from_utf8_lossy(&out.stdout).to_string();
        for flag in words.iter().filter(|w| w.starts_with("--")) {
            assert!(help.contains(flag), "{line}: `{flag}` is not in\n{help}");
        }
        verbs += 1;
    }
    assert_eq!(verbs, 2, "the worked example is two commands");
}

#[test]
fn the_worked_example_runs_as_written() {
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("signer.key");
    let recipe = dir.path().join("web-login-recipe.example.json");
    let signed = dir.path().join("signed.json");
    std::fs::write(&recipe, EXAMPLE).unwrap();

    let mut public_key = String::new();
    for words in documented_commands() {
        assert_eq!(words[0], "opensesame");
        let args: Vec<String> = words[1..]
            .iter()
            .map(|word| {
                word.replace("$KEY", &key.display().to_string())
                    .replace("$RECIPE", &recipe.display().to_string())
                    .replace("$SIGNED", &signed.display().to_string())
            })
            .collect();
        let out = opensesame(dir.path()).args(&args).output().unwrap();
        assert!(
            out.status.success(),
            "{words:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        if args[1..].starts_with(&["signer".to_owned(), "keygen".to_owned()]) {
            let made: Value = serde_json::from_slice(&out.stdout).unwrap();
            public_key = made["public_key"].as_str().unwrap().to_owned();
            let private = std::fs::read_to_string(&key).unwrap();
            assert!(!String::from_utf8_lossy(&out.stdout).contains(private.trim()));
        }
    }

    // What was signed is the example, signed by that key, with a fresh window.
    let stored = RecipeDocument::parse(std::fs::read(&signed).unwrap().as_slice()).unwrap();
    stored
        .verify(&parse_public_key_hex(&public_key).unwrap())
        .expect("signed by the key keygen made");
    stored
        .check_window(chrono::Utc::now())
        .expect("inside its window");
    let example = RecipeDocument::parse(EXAMPLE.as_bytes()).unwrap();
    assert_eq!(stored.change_password, example.change_password);
    assert_eq!(
        (&stored.origin, &stored.recipe_id),
        (&example.origin, &example.recipe_id)
    );
    assert_ne!(stored.expires_at, example.expires_at);
    assert_eq!(stored.canary, None, "a signature is not a canary");
}
