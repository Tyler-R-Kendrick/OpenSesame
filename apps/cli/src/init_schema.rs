//! Initialize a private env-spec project contract without overwriting files.

pub(crate) fn init_schema(path: &std::path::Path) -> anyhow::Result<()> {
    const TEMPLATE: &[u8] = b"# @defaultSensitive=true\n# Native OpenSesame project contract. Add public defaults explicitly.\n";
    crate::write_private_new(path, TEMPLATE)?;
    println!(
        "{}",
        serde_json::json!({"initialized": path, "format": "env-spec"})
    );
    Ok(())
}
