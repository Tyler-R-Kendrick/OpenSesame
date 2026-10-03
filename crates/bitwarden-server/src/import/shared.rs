//! What people share, moving in after the people themselves (ADR 0148 §2):
//! organizations — members, collections, their ciphers and files — and
//! emergency contacts. Each organization is written in one transaction once
//! every account has landed, so a member's account is here to be found.

use opensesame_storage::bitwarden::{
    ArrivalOutcome, BitwardenEmergencyAccess, BitwardenOrgArrival,
};
use opensesame_storage::Db;

use super::files::write_attachments;
use super::{ArrivingAttachment, LeftBehind, Source, WriteOptions, Written};

/// One organization as read from a source.
#[derive(Clone, Debug)]
pub struct ArrivingOrganization {
    pub arrival: BitwardenOrgArrival,
    /// Files on its ciphers, written after it.
    pub attachments: Vec<ArrivingAttachment>,
    pub left_behind: LeftBehind,
}

/// What became of one organization.
#[derive(Clone, Debug)]
pub struct OrgReport {
    pub name: String,
    pub written: Written,
    pub members: usize,
    pub collections: usize,
    pub ciphers: usize,
    pub attachments: usize,
    /// Members the organization's own policies excluded; they arrived revoked.
    pub revoked: usize,
    pub left_behind: LeftBehind,
}

/// What became of everything shared.
#[derive(Clone, Debug, Default)]
pub struct SharedReport {
    pub organizations: Vec<OrgReport>,
    /// Emergency contacts written, of those read.
    pub emergency_written: usize,
    pub emergency_read: usize,
}

fn written(outcome: ArrivalOutcome) -> Written {
    match outcome {
        ArrivalOutcome::Created => Written::Created,
        ArrivalOutcome::Replaced => Written::Replaced,
        ArrivalOutcome::EmailTaken => Written::EmailTaken,
        ArrivalOutcome::IdTaken => Written::IdTaken,
    }
}

/// Write every organization and emergency contact `source` carries. Run it
/// after [`super::write`], so the accounts they name are here.
///
/// # Errors
///
/// Returns an error when the database fails; organizations written before
/// it stay written, and the one being written is rolled back whole.
pub async fn write_shared(
    db: &Db,
    source: &Source,
    options: WriteOptions,
) -> anyhow::Result<SharedReport> {
    let mut report = SharedReport {
        emergency_read: source.emergency.len(),
        ..SharedReport::default()
    };
    for arriving in &source.organizations {
        let arrival = &arriving.arrival;
        let mut left_behind = arriving.left_behind.clone();
        let (written, revoked) = if options.dry_run {
            (Written::DryRun, 0)
        } else {
            let arrived = db
                .bitwarden_arrive_organization(arrival, options.replace)
                .await?;
            (written(arrived.outcome), arrived.revoked)
        };
        let attachments = if matches!(written, Written::Created | Written::Replaced) {
            write_attachments(db, &arriving.attachments, &mut left_behind).await?
        } else {
            arriving.attachments.len()
        };
        report.organizations.push(OrgReport {
            name: arrival.org.name.clone(),
            written,
            members: arrival.members.len(),
            collections: arrival.collections.len(),
            ciphers: arrival.ciphers.len(),
            attachments,
            revoked,
            left_behind,
        });
    }
    if !options.dry_run {
        for access in &source.emergency {
            if write_emergency(db, access).await? {
                report.emergency_written += 1;
            }
        }
    }
    Ok(report)
}

async fn write_emergency(db: &Db, access: &BitwardenEmergencyAccess) -> anyhow::Result<bool> {
    db.bitwarden_arrive_emergency_access(access).await
}
