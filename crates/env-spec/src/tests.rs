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
