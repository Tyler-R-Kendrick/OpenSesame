use chrono::{Duration, Utc};
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};

use super::*;

const ORIGIN: &str = "https://login.example";

fn document() -> Value {
    json!({
        "schema_version": 1,
        "recipe_id": "rcp_login_example",
        "origin": ORIGIN,
        "expires_at": (Utc::now() + Duration::days(30)).to_rfc3339(),
        "change_password": {
            "change_url": "https://login.example/.well-known/change-password",
            "current_password_selector": "#current",
            "new_password_selector": "#new",
            "confirm_password_selector": "#confirm",
            "submit_selector": "#save"
        }
    })
}

fn parse(value: &Value) -> Result<RecipeDocument, RecipeError> {
    RecipeDocument::parse(value.to_string().as_bytes())
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

#[test]
fn a_well_formed_document_parses_and_names_nothing_else() {
    let parsed = parse(&document()).expect("valid");
    assert_eq!(parsed.origin, ORIGIN);
    assert_eq!(parsed.steps().new_password_selector, "#new");
    assert_eq!(parsed.canary, None);
    assert_eq!(parsed.signature, None);
    parsed.check_window(Utc::now()).expect("inside its window");
}

#[test]
fn an_unknown_member_is_refused_at_every_level() {
    for (path, doc) in [
        ("trust", {
            let mut doc = document();
            doc["trust"] = json!("canary_verified");
            doc
        }),
        ("steps", {
            let mut doc = document();
            doc["steps"] = json!([{"click": "#x"}]);
            doc
        }),
        ("nested", {
            let mut doc = document();
            doc["change_password"]["value"] = json!("hunter2");
            doc
        }),
        ("canary", {
            let mut doc = document();
            doc["canary"] = json!({"verified_at": Utc::now().to_rfc3339(), "result": "passed"});
            doc
        }),
        ("signature", {
            let mut doc = document();
            doc["signature"] =
                json!({"alg": "ed25519", "key_id": "rsk_x", "value": "00", "extra": 1});
            doc
        }),
    ] {
        assert!(
            matches!(parse(&doc), Err(RecipeError::Malformed(_))),
            "{path} must be refused as an unknown member"
        );
    }
}

#[test]
fn each_structural_rule_names_what_it_refuses() {
    let broken = |edit: &dyn Fn(&mut Value)| {
        let mut doc = document();
        edit(&mut doc);
        parse(&doc).unwrap_err()
    };
    assert_eq!(
        broken(&|d| d["schema_version"] = json!(2)),
        RecipeError::UnsupportedVersion(2)
    );
    for id in [
        "login",
        "rcp_",
        "rcp_UPPER",
        "rcp_has space",
        &format!("rcp_{}", "a".repeat(64)),
    ] {
        assert_eq!(
            broken(&|d| d["recipe_id"] = json!(id)),
            RecipeError::BadRecipeId,
            "{id}"
        );
    }
    for origin in [
        "http://login.example",
        "https://login.example/path",
        "https://login.example/?q=1",
        "https://user:pw@login.example",
        "https://LOGIN.example",
        "https://login.example:443",
        "login.example",
    ] {
        assert_eq!(
            broken(&|d| d["origin"] = json!(origin)),
            RecipeError::BadOrigin,
            "{origin}"
        );
    }
    for url in [
        "http://login.example/x",
        "https://evil.example/x",
        "https://login.example:8443/x",
        "https://user:pw@login.example/x",
        "not a url",
    ] {
        assert_eq!(
            broken(&|d| d["change_password"]["change_url"] = json!(url)),
            RecipeError::OffOrigin,
            "{url}"
        );
    }
    for (member, name) in [
        ("new_password_selector", "new_password_selector"),
        ("submit_selector", "submit_selector"),
        ("current_password_selector", "current_password_selector"),
        ("confirm_password_selector", "confirm_password_selector"),
    ] {
        for bad in [
            json!("  "),
            json!("x".repeat(MAX_SELECTOR_CHARS + 1)),
            json!("a\nb"),
        ] {
            assert_eq!(
                broken(&|d| d["change_password"][member] = bad.clone()),
                RecipeError::BadSelector(name)
            );
        }
    }
    assert_eq!(
        broken(&|d| d["expires_at"] = json!("tomorrow")),
        RecipeError::BadTimestamp("expires_at")
    );
    assert_eq!(
        broken(&|d| d["canary"] = json!({"verified_at": "soon"})),
        RecipeError::BadTimestamp("canary.verified_at")
    );
}

#[test]
fn a_document_is_bounded_and_must_be_text() {
    let big = vec![b' '; MAX_RECIPE_BYTES + 1];
    assert_eq!(RecipeDocument::parse(&big), Err(RecipeError::TooLarge));
    assert!(matches!(
        RecipeDocument::parse(&[0xff, 0xfe]),
        Err(RecipeError::Malformed(_))
    ));
    assert!(matches!(
        RecipeDocument::parse(b"[1,2]"),
        Err(RecipeError::Malformed(_))
    ));
}

#[test]
fn a_repeated_member_is_refused_so_a_signature_covers_one_reading() {
    // Two readers that disagree about which `origin` wins would sign and replay
    // different documents; the parser refuses the ambiguity outright.
    let expires = (Utc::now() + Duration::days(30)).to_rfc3339();
    let text = |origin: &str, submit: &str| {
        format!(
            r##"{{"schema_version":1,{origin}"recipe_id":"rcp_login_example",
            "expires_at":"{expires}","change_password":{{
            "change_url":"https://login.example/change","current_password_selector":null,
            "new_password_selector":"#new","confirm_password_selector":null,{submit}}}}}"##
        )
    };
    let once = text(
        r#""origin":"https://login.example","#,
        r##""submit_selector":"#save""##,
    );
    RecipeDocument::parse(once.as_bytes()).expect("the unrepeated form is valid");
    let twice = text(
        r#""origin":"https://login.example","origin":"https://evil.example","#,
        r##""submit_selector":"#save""##,
    );
    assert!(matches!(
        RecipeDocument::parse(twice.as_bytes()),
        Err(RecipeError::Malformed(_))
    ));
    let nested = text(
        r#""origin":"https://login.example","#,
        r##""submit_selector":"#save","submit_selector":"#other""##,
    );
    assert!(matches!(
        RecipeDocument::parse(nested.as_bytes()),
        Err(RecipeError::Malformed(_))
    ));
}

#[test]
fn the_window_bounds_expiry_and_the_canary() {
    let now = Utc::now();
    let at = |edit: &dyn Fn(&mut Value)| {
        let mut doc = document();
        edit(&mut doc);
        parse(&doc).unwrap().check_window(now)
    };
    assert_eq!(
        at(&|d| d["expires_at"] = json!((now - Duration::seconds(1)).to_rfc3339())),
        Err(RecipeError::Expired)
    );
    assert_eq!(
        at(&|d| d["expires_at"] =
            json!((now + Duration::days(MAX_LIFETIME_DAYS + 1)).to_rfc3339())),
        Err(RecipeError::LifetimeTooLong)
    );
    assert_eq!(
        at(&|d| d["canary"] = json!({"verified_at": (now + Duration::hours(1)).to_rfc3339()})),
        Err(RecipeError::CanaryInTheFuture)
    );
    assert_eq!(
        at(
            &|d| d["canary"] = json!({"verified_at": (now - Duration::days(CANARY_MAX_AGE_DAYS + 1)).to_rfc3339()})
        ),
        Err(RecipeError::CanaryStale)
    );
    assert_eq!(
        at(&|d| d["canary"] = json!({"verified_at": (now - Duration::days(2)).to_rfc3339()})),
        Ok(())
    );
}

#[test]
fn a_signature_verifies_only_this_document_under_only_this_key() {
    let signer = key(7);
    let mut doc = parse(&document()).unwrap();
    assert_eq!(
        doc.verify(&signer.verifying_key()),
        Err(RecipeError::Unsigned)
    );
    doc.sign(&signer).unwrap();
    doc.verify(&signer.verifying_key()).expect("signed");
    assert_eq!(
        doc.signer_key_id().unwrap(),
        key_id_of(&signer.verifying_key())
    );
    assert!(key_id_of(&signer.verifying_key()).starts_with("rsk_"));

    // Another key, even one the signature does not name.
    assert_eq!(
        doc.verify(&key(8).verifying_key()),
        Err(RecipeError::KeyMismatch)
    );

    // Any change to what is signed breaks it.
    for edit in [
        (|d: &mut RecipeDocument| d.origin = "https://other.example".into())
            as fn(&mut RecipeDocument),
        |d| d.change_password.submit_selector = "#other".into(),
        |d| d.recipe_id = "rcp_other".into(),
        |d| d.expires_at = (Utc::now() + Duration::days(31)).to_rfc3339(),
        |d| {
            d.canary = Some(CanaryAttestation {
                verified_at: Utc::now().to_rfc3339(),
            });
        },
    ] {
        let mut tampered = doc.clone();
        edit(&mut tampered);
        assert_eq!(
            tampered.verify(&signer.verifying_key()),
            Err(RecipeError::BadSignature)
        );
    }

    // A forged key id, a wrong algorithm and a truncated value.
    let mut forged = doc.clone();
    forged.signature.as_mut().unwrap().key_id = "rsk_00000000000000000000000000000000".into();
    assert_eq!(
        forged.verify(&signer.verifying_key()),
        Err(RecipeError::KeyMismatch)
    );
    let mut alg = doc.clone();
    alg.signature.as_mut().unwrap().alg = "rsa".into();
    assert_eq!(
        alg.verify(&signer.verifying_key()),
        Err(RecipeError::UnsupportedAlgorithm)
    );
    let mut short = doc.clone();
    short.signature.as_mut().unwrap().value.truncate(10);
    assert_eq!(
        short.verify(&signer.verifying_key()),
        Err(RecipeError::BadSignature)
    );
}

#[test]
fn the_signed_form_ignores_encoding_and_the_signature_itself() {
    let signer = key(9);
    let mut doc = parse(&document()).unwrap();
    doc.sign(&signer).unwrap();
    // The same document, spelled with other whitespace and key order, and with
    // a null for an absent option, is the same bytes.
    let reordered = serde_json::to_string_pretty(&serde_json::to_value(&doc).unwrap()).unwrap();
    let again = RecipeDocument::parse(reordered.as_bytes()).unwrap();
    again
        .verify(&signer.verifying_key())
        .expect("encoding is not signed");
    assert_eq!(again.digest().unwrap(), doc.digest().unwrap());
    assert_eq!(doc.unsigned().digest().unwrap(), doc.digest().unwrap());
    assert!(doc.digest().unwrap().starts_with("sha256:"));

    // A signature for a recipe is not a signature for the bare canonical JSON.
    let message = doc.signing_message().unwrap();
    assert!(message.starts_with(SIGNING_DOMAIN.as_bytes()));

    // Re-signing replaces the signature, and the digest does not move.
    let digest = doc.digest().unwrap();
    doc.sign(&key(10)).unwrap();
    assert_eq!(doc.digest().unwrap(), digest);
}

#[test]
fn keys_parse_strictly_and_never_echo() {
    let signer = key(3);
    let public = hex::encode(signer.verifying_key().as_bytes());
    assert_eq!(
        parse_public_key_hex(&public).unwrap(),
        signer.verifying_key()
    );
    assert_eq!(
        parse_public_key_hex(&format!("  {public}\n")).unwrap(),
        signer.verifying_key()
    );
    for bad in ["", "zz", &public[..62], &format!("{public}00")] {
        assert!(
            matches!(parse_public_key_hex(bad), Err(RecipeError::BadKey(_))),
            "{bad}"
        );
    }
    let seed = hex::encode([3u8; 32]);
    assert_eq!(
        signing_key_from_seed_hex(&seed).unwrap().to_bytes(),
        [3u8; 32]
    );
    let refusal = signing_key_from_seed_hex("hunter2-not-a-key").unwrap_err();
    assert!(!refusal.to_string().contains("hunter2"));
}

#[test]
fn origins_canonicalize_the_way_a_rotation_target_does() {
    assert_eq!(
        canonical_origin("https://login.example").as_deref(),
        Some(ORIGIN)
    );
    assert_eq!(
        canonical_origin("https://login.example/").as_deref(),
        Some(ORIGIN)
    );
    assert_eq!(
        canonical_origin("https://LOGIN.example:443").as_deref(),
        Some(ORIGIN)
    );
    assert_eq!(
        canonical_origin("https://login.example:8443").as_deref(),
        Some("https://login.example:8443")
    );
    for bad in [
        "http://login.example",
        "https://login.example/a",
        "https://login.example?x",
        "https://login.example#x",
        "https://u@login.example",
        "login.example",
        "",
    ] {
        assert_eq!(canonical_origin(bad), None, "{bad}");
    }
}
