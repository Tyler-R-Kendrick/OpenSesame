//! GA-F-04 — live `OpenFGA` projection under the authority writer lease.

use opensesame_domain::GrantId;
use opensesame_provider_openfga::grant_to_openfga_tuples;
use opensesame_storage::authority::ProjectionMark;
use tracing::{info, warn};

use crate::app_state::AppState;

const OPENFGA_STORE: &str = "openfga";
const WRITER_ID: &str = "gateway:openfga-projector";
const LEASE_SECONDS: i64 = 30;

/// Project one grant's relationship tuples to `OpenFGA` when configured.
///
/// No-ops when `OpenFGA` is unset. Mapping refusals leave the projection
/// unmarked so auth stays fail-closed on freshness. Lease loss or write
/// failure returns an error.
pub async fn project_grant_live(
    st: &AppState,
    organization_id: &str,
    grant_id: &str,
) -> anyhow::Result<()> {
    let Some(openfga) = &st.openfga else {
        return Ok(());
    };
    let Some(lease) = st.db.acquire_writer_lease(WRITER_ID, LEASE_SECONDS).await? else {
        anyhow::bail!("authority writer lease held by another projector");
    };

    let parsed = GrantId::parse(grant_id)?;
    let Some(grant) = st.db.find_grant(&parsed).await? else {
        anyhow::bail!("grant {grant_id} missing after issue");
    };

    let tuples = match grant_to_openfga_tuples(&grant) {
        Ok(tuples) => tuples,
        Err(error) => {
            warn!(
                grant_id,
                code = error.code(),
                message = error.message(),
                "openfga projection quarantined grant"
            );
            return Ok(());
        }
    };

    st.db.assert_writer_lease(&lease).await?;
    if !tuples.is_empty() {
        openfga.write_tuples(&tuples).await?;
    }

    let revision = i64::from(grant.version);
    let mark = ProjectionMark {
        store: OPENFGA_STORE,
        organization_id,
        subject_kind: "grant",
        subject_id: grant_id,
        committed_revision: revision,
    };
    st.db.record_projection_applied(&mark, None).await?;
    st.db.assert_writer_lease(&lease).await?;
    info!(
        grant_id,
        tuples = tuples.len(),
        "openfga projection applied"
    );
    Ok(())
}
