//! The worked example in `docs/operators/web-login-recipes.md`, run line by
//! line through the real binary against a stand-in Host (ADR 0076 §4, ADR
//! 0159), against the example recipe file the document embeds.

mod hooks_mock;
mod rotate_recipes_mock;

use opensesame_rotation_web::recipe_doc::{parse_public_key_hex, RecipeDocument};
use rotate_recipes_mock::{host, opensesame, rotate, ENCODED_ORIGIN, EXAMPLE};
use serde_json::{json, Value};

const DOC: &str = include_str!("../../../docs/operators/web-login-recipes.md");

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
    for line in DOC
        .lines()
        .filter(|l| l.starts_with("opensesame access connectors rotate "))
    {
        let words: Vec<&str> = line.split_whitespace().skip(4).collect();
        let (noun, verb) = (words[0], words[1]);
        assert!(matches!(noun, "recipe" | "signer"), "{line}");
        let out = opensesame(dir.path())
            .args(["access", "connectors", "rotate", noun, verb, "--help"])
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
    assert_eq!(verbs, 6, "the worked example is six commands");
}

#[test]
fn the_worked_example_runs_as_written() {
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("signer.key");
    let recipe = dir.path().join("web-login-recipe.example.json");
    let signed = dir.path().join("signed.json");
    std::fs::write(&recipe, EXAMPLE).unwrap();
    let (server, seen) = host();

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
        let out = rotate(dir.path(), &server)
            .args(&args[3..])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{words:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        if args[3..].starts_with(&["signer".to_owned(), "keygen".to_owned()]) {
            let made: Value = serde_json::from_slice(&out.stdout).unwrap();
            public_key = made["public_key"].as_str().unwrap().to_owned();
            let private = std::fs::read_to_string(&key).unwrap();
            assert!(!String::from_utf8_lossy(&out.stdout).contains(private.trim()));
        }
    }

    let seen = seen.lock().unwrap();
    let calls: Vec<(&str, &str)> = seen
        .iter()
        .map(|r| (r.method.as_str(), r.path.as_str()))
        .collect();
    assert_eq!(
        calls,
        [
            ("POST", "/api/v1/web-login/signers"),
            (
                "PUT",
                &format!("/api/v1/web-login/recipes/{ENCODED_ORIGIN}")
            ),
            (
                "POST",
                &format!("/api/v1/web-login/recipes/{ENCODED_ORIGIN}/canary")
            ),
            (
                "GET",
                &format!("/api/v1/web-login/recipes/{ENCODED_ORIGIN}")
            ),
        ],
        "keygen and sign are local; the rest name the Host"
    );

    // The pin names the key's public half, never the private one.
    let pin: Value = serde_json::from_str(&seen[0].body).unwrap();
    assert_eq!(
        pin,
        json!({"public_key": public_key, "label": "release-signer"})
    );
    assert!(seen[0].authorization.starts_with("Bearer operator:"));

    // What was stored is the example, signed by that key, with a fresh window.
    assert_eq!(seen[1].if_match, "\"0\"");
    let stored = RecipeDocument::parse(seen[1].body.as_bytes()).unwrap();
    stored
        .verify(&parse_public_key_hex(&public_key).unwrap())
        .expect("signed by the pinned key");
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
