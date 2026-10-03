use super::*;

const FIXTURE: &str = r#"{
  "schema_path": "tests/fixtures/demo.env.schema",
  "parser": "@env-spec/parser",
  "items": [
{
  "key": "API_URL",
  "sensitive": false,
  "required": false,
  "public": true,
  "type": {"fn": "url"},
  "value": "http://localhost:3000",
  "resolver": null,
  "decorators": [{"name": "public", "value": true}]
},
{
  "key": "WORKOS_API_KEY",
  "sensitive": true,
  "required": true,
  "public": false,
  "type": {"fn": "string"},
  "value": null,
  "resolver": {
    "fn": "opensesameConnection",
    "args": [
      {"value": "conn://demo/workos"},
      {"key": "projection", "value": "legacy-token"}
    ]
  },
  "decorators": [{"name": "sensitive", "value": true}]
},
{
  "key": "GITHUB_TOKEN",
  "sensitive": true,
  "required": true,
  "public": false,
  "type": null,
  "value": null,
  "resolver": {
    "fn": "opensesame",
    "args": [{"value": "conn://demo/github"}]
  },
  "decorators": [{"name": "sensitive", "value": true}]
}
  ]
}"#;

#[test]
fn summary_hides_secrets() {
    let doc = parse_schema_json(FIXTURE).unwrap();
    let s = schema_summary(&doc);
    let text = s.to_string();
    assert!(text.contains("WORKOS_API_KEY"));
    assert!(!text.contains("ostest_"));
}

#[test]
fn agent_resolve_placeholders_and_handles() {
    let doc = parse_schema_json(FIXTURE).unwrap();
    let policy = DevDeliveryPolicy::agent_default();
    let entries = resolve_for_delivery(&doc, &policy, true).unwrap();
    let workos = entries.iter().find(|e| e.key == "WORKOS_API_KEY").unwrap();
    assert_eq!(workos.delivery, CredentialDeliveryMode::Placeholder);
    assert!(workos.env_value.as_ref().unwrap().starts_with("ostest_"));
    let gh = entries.iter().find(|e| e.key == "GITHUB_TOKEN").unwrap();
    assert_eq!(gh.delivery, CredentialDeliveryMode::Handle);
    assert_eq!(gh.env_value.as_deref(), Some("conn://demo/github"));
}

#[test]
fn each_projection_gets_its_own_placeholder() {
    let doc = parse_schema_json(FIXTURE).unwrap();
    let policy = DevDeliveryPolicy::agent_default();
    let first = resolve_for_delivery(&doc, &policy, true).unwrap();
    let second = resolve_for_delivery(&doc, &policy, true).unwrap();
    let pick = |entries: &[ResolvedEnvEntry]| {
        entries
            .iter()
            .find(|e| e.key == "WORKOS_API_KEY")
            .cloned()
            .unwrap()
    };
    let (a, b) = (pick(&first), pick(&second));
    let (pa, pb) = (a.env_value.clone().unwrap(), b.env_value.clone().unwrap());
    // Two projections of the same connection must not share a placeholder:
    // egress substitution keys off the text alone.
    assert_ne!(pa, pb);
    assert!(pa.starts_with("ostest_"));
    // And the placeholder handed out is one the projection will accept back.
    assert!(a.projection.as_ref().unwrap().accepts_placeholder(&pa));
    // Each projection admits only its own placeholder, not its neighbour's.
    assert!(!a.projection.as_ref().unwrap().accepts_placeholder(&pb));
    assert!(b.projection.as_ref().unwrap().accepts_placeholder(&pb));
}

#[test]
fn bridge_roundtrip_fixture() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/demo.env.schema");
    assert!(path.exists(), "fixture missing at {}", path.display());
    let node_ok = Command::new("node").arg("--version").output().is_ok();
    if !node_ok {
        eprintln!("skip bridge_roundtrip_fixture: node not installed");
        return;
    }
    let doc = match parse_schema_file(&path) {
        Ok(doc) => doc,
        Err(EnvSpecError::Bridge(msg)) if msg.contains("ERR_MODULE_NOT_FOUND") => {
            eprintln!("skip bridge_roundtrip_fixture: env-spec-bridge deps not installed ({msg})");
            return;
        }
        Err(e) => panic!("bridge parse failed: {e}"),
    };
    assert!(doc.items.iter().any(|i| i.key == "WORKOS_API_KEY"));
    let workos = doc
        .items
        .iter()
        .find(|i| i.key == "WORKOS_API_KEY")
        .unwrap();
    assert!(workos.sensitive);
    assert!(workos.value.is_none());
    let entries = resolve_for_delivery(&doc, &DevDeliveryPolicy::agent_default(), true).unwrap();
    let workos_e = entries.iter().find(|e| e.key == "WORKOS_API_KEY").unwrap();
    assert_eq!(workos_e.delivery, CredentialDeliveryMode::Placeholder);
    assert!(workos_e.env_value.as_ref().unwrap().starts_with("ostest_"));
}

const LOGIN_FIXTURE: &str = r#"{
  "schema_path": "login.env.schema",
  "parser": "@env-spec/parser",
  "items": [
{
  "key": "APP_PASSWORD",
  "sensitive": true,
  "required": true,
  "resolver": {
    "fn": "opensesameLogin",
    "args": [
      {"value": "Web/app.example"},
      {"key": "origin", "value": "https://app.example"},
      {"key": "action", "value": "/session"},
      {"key": "field", "value": "password"}
    ]
  }
},
{
  "key": "HALF_DECLARED",
  "sensitive": true,
  "required": false,
  "resolver": {
    "fn": "opensesameLogin",
    "args": [{"value": "Web/other"}, {"key": "origin", "value": "https://other.example"}]
  }
}
  ]
}"#;

#[test]
fn a_web_login_resolves_omitted_with_its_declaration_and_no_value() {
    let doc = parse_schema_json(LOGIN_FIXTURE).unwrap();
    for agent in [true, false] {
        let policy = if agent {
            DevDeliveryPolicy::agent_default()
        } else {
            DevDeliveryPolicy::development_default()
        };
        let entries = resolve_for_delivery(&doc, &policy, agent).unwrap();
        let login = &entries[0];
        assert!(login.omitted);
        assert!(login.env_value.is_none(), "a login never materializes");
        assert_eq!(
            login.login,
            Some(WebLogin {
                store_path: "Web/app.example".into(),
                origin: "https://app.example".into(),
                action: "/session".into(),
                field: "password".into(),
                ca_file: None,
            })
        );
        let half = &entries[1];
        assert!(half.omitted);
        assert!(half.login.is_none());
        assert!(half.warning.as_deref().unwrap().contains("field="));
    }
}

#[test]
fn an_entry_without_a_login_serializes_as_before() {
    let doc = parse_schema_json(FIXTURE).unwrap();
    let entries = resolve_for_delivery(&doc, &DevDeliveryPolicy::agent_default(), true).unwrap();
    let text = serde_json::to_string(&entries).unwrap();
    assert!(!text.contains("\"login\""), "{text}");
}

fn scoped(args: &str) -> EnvSpecDocument {
    let json = r#"{"schema_path":"x","parser":"p","items":[{
        "key":"GITHUB_TOKEN","sensitive":true,"required":true,"public":false,
        "type":null,"value":null,"decorators":[],
        "resolver":{"fn":"opensesameConnection","args":[
            {"value":"conn://demo/github"},
            {"key":"projection","value":"legacy-token"}ARGS
        ]}}]}"#;
    parse_schema_json(&json.replace("ARGS", args)).unwrap()
}

fn resolve_scoped(args: &str) -> Result<Vec<ResolvedEnvEntry>, EnvSpecError> {
    resolve_for_delivery(&scoped(args), &DevDeliveryPolicy::agent_default(), true)
}

#[test]
fn an_entry_that_declares_no_paths_carries_none_and_is_never_widened_to_the_root() {
    let entry = resolve_scoped("").unwrap().remove(0);
    assert!(entry.path_prefixes.is_empty(), "{:?}", entry.path_prefixes);
    let wire = serde_json::to_value(&entry).unwrap();
    assert!(wire.get("path_prefixes").is_none(), "{wire}");
}

#[test]
fn declared_paths_and_methods_are_carried_into_the_entry() {
    let entry = resolve_scoped(
        r#",{"key":"paths","value":"/repos/acme, /user/ ,/repos/acme"},
            {"key":"methods","value":"get,Post"}"#,
    )
    .unwrap()
    .remove(0);
    assert_eq!(entry.path_prefixes, ["/repos/acme", "/user"]);
    let placement = &entry.projection.as_ref().unwrap().placement;
    assert_eq!(placement.methods, ["GET", "POST"]);
}

#[test]
fn a_paths_declaration_without_methods_fails_the_resolve_instead_of_granting_write_verbs() {
    let error = resolve_scoped(r#",{"key":"paths","value":"/user"}"#)
        .expect_err("paths= alone must not default to write methods");
    let text = error.to_string();
    assert!(text.starts_with("GITHUB_TOKEN: "), "{text}");
    assert!(text.contains("methods="), "{text}");
}

#[test]
fn methods_alone_still_narrow_the_placement_and_carry_no_paths() {
    let entry = resolve_scoped(r#",{"key":"methods","value":"GET"}"#)
        .unwrap()
        .remove(0);
    assert!(entry.path_prefixes.is_empty());
    assert_eq!(
        entry.projection.as_ref().unwrap().placement.methods,
        ["GET"]
    );
}

#[test]
fn a_paths_declaration_that_does_not_bound_the_surrogate_fails_the_resolve() {
    for bad in ["/", "", " , ", "repos", "/repos/../x", "/a?b", "/user,/"] {
        let error = resolve_scoped(&format!(r#",{{"key":"paths","value":"{bad}"}}"#))
            .expect_err(&format!("{bad:?} must be refused"));
        let text = error.to_string();
        assert!(text.starts_with("GITHUB_TOKEN: "), "{text}");
        assert!(text.contains("paths="), "{text}");
    }
}

#[test]
fn a_methods_declaration_that_names_no_http_method_fails_the_resolve() {
    for bad in ["", "GET,TEAPOT", "*", "CONNECT"] {
        let error = resolve_scoped(&format!(r#",{{"key":"methods","value":"{bad}"}}"#))
            .expect_err(&format!("{bad:?} must be refused"));
        assert!(error.to_string().contains("methods="), "{error}");
    }
}
