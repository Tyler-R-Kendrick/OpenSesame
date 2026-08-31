//! The motivating ceremony, walked end to end (ADR 0082).
//!
//! "Setting up a github account and registering a github app for this PWA is
//! far too technical and complicated for most users" is the problem ADR 0082
//! was written for, and GitHub is the provider it is written against. These
//! tests walk that ceremony through the vocabulary, so the shape of the real
//! flow is pinned rather than only its pieces.
//!
//! The unit tests in each module cover the rules individually. What is checked
//! here is that they compose into the flow ADR 0039 spells out — register the
//! App, install it on the org, set the backup target — with the registration
//! going to GitHub's own manifest endpoint and only the rest going near a
//! browser.

use opensesame_ceremony::{
    resolve, Act, CaptureRefusal, Completion, Consent, DeclaredSlots, GrantedPermissions, Guard,
    Incomplete, Phase, Presence, ProviderCapability, Refusal, RoundTrip, Slot, Tier,
};

const PEM: &str = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";

/// GitHub as the catalog records it: a manifest flow, a checked-in recipe for
/// the rest, and agentic permitted by the deployment.
fn github() -> ProviderCapability {
    ProviderCapability {
        has_native_registration: true,
        has_recipe: true,
        agentic_allowed: true,
    }
}

/// What ADR 0039's backup path needs from the App.
fn backup_permissions() -> GrantedPermissions {
    GrantedPermissions {
        requested: vec!["contents:write".into(), "metadata:read".into()],
        granted: vec!["contents:write".into(), "metadata:read".into()],
    }
}

fn installation_token() -> RoundTrip {
    RoundTrip {
        used: "minted an installation token".into(),
        identified_as: "opensesame-backup on acme-corp".into(),
    }
}

#[test]
fn the_github_ceremony_uses_the_manifest_endpoint_and_a_recipe_for_the_rest() {
    // The division ADR 0082 §1 draws. GitHub publishes a registration endpoint,
    // so registration never goes near a browser — even though a recipe exists
    // and agentic is enabled, both of which would otherwise be eligible.
    assert_eq!(resolve(Phase::Registration, github()), Tier::ProviderNative);

    // And the three things the endpoint cannot do are exactly what is left:
    // being signed in as the right identity, installing on the org, and
    // proving the result works.
    assert_eq!(
        resolve(Phase::Preconditions, github()),
        Tier::Deterministic,
        "a manifest endpoint cannot make somebody signed in",
    );
    assert_eq!(
        resolve(Phase::Installation, github()),
        Tier::Deterministic,
        "installing is a separate step, and the one most often skipped",
    );
    assert_eq!(resolve(Phase::Verification, github()), Tier::Deterministic);
}

#[test]
fn the_ceremony_captures_what_adr_0039_needs_and_refuses_what_it_did_not_declare() {
    // The App Manifest response carries the id, the key and the webhook secret;
    // the webhook then carries the installation id. Four slots, declared up
    // front.
    let mut slots = DeclaredSlots::declare(&[
        Slot::AppId,
        Slot::PrivateKey,
        Slot::WebhookSecret,
        Slot::InstallationId,
    ]);

    assert_eq!(slots.admit(Slot::AppId, "48271"), Ok(()));
    assert_eq!(slots.admit(Slot::PrivateKey, PEM), Ok(()));
    assert_eq!(slots.admit(Slot::WebhookSecret, "whsec_a1b2c3d4e5"), Ok(()));

    // Not yet installed, so the run is not finished and knows it.
    assert_eq!(slots.outstanding(), vec![Slot::InstallationId]);
    assert!(!slots.is_complete());

    // A step that tries to take something else out of the page is refused by
    // the declaration, not by a reviewer noticing later.
    assert_eq!(
        slots.admit(Slot::ClientSecret, "not-part-of-this-ceremony"),
        Err(CaptureRefusal::SlotNotDeclared),
    );

    assert_eq!(slots.admit(Slot::InstallationId, "99001"), Ok(()));
    assert!(slots.is_complete());
}

#[test]
fn the_ceremony_stops_where_a_person_has_to_act() {
    // GitHub's create page and install page are consent screens. They are
    // supposed to be human, and the guard is what keeps an agent out of them.
    let guard = Guard::new(
        Presence::Watching,
        false,
        Consent::for_organizations(&["acme-corp"]),
    );

    // Navigating to the right page and filling the manifest form: the
    // orchestration, which is the part worth automating.
    assert_eq!(guard.admit(Act::Navigate, None), Ok(()));
    assert_eq!(guard.admit(Act::FillField, None), Ok(()));
    assert_eq!(guard.admit(Act::SubmitRegistration, None), Ok(()));

    // Installing on the org the user named: allowed, and only that one.
    assert_eq!(
        guard.admit(Act::SelectOrganization, Some("acme-corp")),
        Ok(())
    );
    assert_eq!(
        guard.admit(Act::SelectOrganization, Some("acme-corp-prod")),
        Err(Refusal::OrganizationNotNamed),
        "installing on the wrong org is picking whose data is at stake",
    );

    // And the things that are never the agent's, whatever tier is running.
    assert_eq!(
        guard.admit(Act::AcceptTerms, None),
        Err(Refusal::TermsAreForAPerson)
    );
    assert_eq!(
        guard.admit(Act::SubmitAccountCreation, None),
        Err(Refusal::AccountCreationIsForAPerson),
    );
    assert_eq!(
        guard.admit(Act::SolveChallenge, None),
        Err(Refusal::ChallengeMustNotBeSolved)
    );
}

#[test]
fn a_registered_but_uninstalled_app_is_the_failure_this_ceremony_exists_to_prevent() {
    // ADR 0082 §6's long fuse: the App is created, the form was green, and
    // backup will silently never work because nobody installed it. The
    // ceremony refuses to report success, and names the missing step.
    let mut slots = DeclaredSlots::declare(&[Slot::AppId, Slot::PrivateKey, Slot::InstallationId]);
    slots.admit(Slot::AppId, "48271").unwrap();
    slots.admit(Slot::PrivateKey, PEM).unwrap();

    let refused = Completion::completed(
        "github",
        "a GitHub App named opensesame-backup",
        "acme-corp",
        &slots,
        backup_permissions(),
        Some(installation_token()),
    );
    assert_eq!(
        refused,
        Err(Incomplete::SlotsOutstanding {
            slots: vec!["installation_id".into()]
        }),
    );
}

#[test]
fn a_github_app_that_came_back_with_admin_org_aborts() {
    // ADR 0082 §5: the recipe declares the exact permission set and the run
    // verifies after. A form that granted more than was asked for is not a
    // registration to keep.
    let mut slots = DeclaredSlots::declare(&[Slot::AppId, Slot::PrivateKey]);
    slots.admit(Slot::AppId, "48271").unwrap();
    slots.admit(Slot::PrivateKey, PEM).unwrap();

    let over_granted = GrantedPermissions {
        requested: vec!["contents:write".into(), "metadata:read".into()],
        granted: vec![
            "contents:write".into(),
            "metadata:read".into(),
            "administration:write".into(),
        ],
    };
    assert_eq!(
        Completion::completed(
            "github",
            "a GitHub App",
            "acme-corp",
            &slots,
            over_granted,
            Some(installation_token()),
        ),
        Err(Incomplete::ExcessPermissions {
            granted: vec!["administration:write".into()]
        }),
    );
}

#[test]
fn a_finished_ceremony_hands_back_a_receipt_a_person_can_read() {
    let mut slots = DeclaredSlots::declare(&[
        Slot::AppId,
        Slot::PrivateKey,
        Slot::WebhookSecret,
        Slot::InstallationId,
    ]);
    slots.admit(Slot::AppId, "48271").unwrap();
    slots.admit(Slot::PrivateKey, PEM).unwrap();
    slots
        .admit(Slot::WebhookSecret, "whsec_a1b2c3d4e5")
        .unwrap();
    slots.admit(Slot::InstallationId, "99001").unwrap();

    let done = Completion::completed(
        "github",
        "a GitHub App named opensesame-backup",
        "acme-corp",
        &slots,
        backup_permissions(),
        Some(installation_token()),
    )
    .expect("everything captured, nothing over-granted, and the token was minted");

    // ADR 0082 §8: what now exists, on which account, and what we hold for it —
    // in the user's words rather than the provider's field names.
    assert_eq!(done.created, "a GitHub App named opensesame-backup");
    assert_eq!(done.on_account, "acme-corp");
    assert_eq!(
        done.holds,
        vec![
            "the app's id".to_string(),
            "a signing key (sealed)".to_string(),
            "a webhook signing secret (sealed)".to_string(),
            "which installation it is".to_string(),
        ],
    );
    assert_eq!(done.proof.used, "minted an installation token");

    // The receipt is shown to a person and stored; nothing captured appears in
    // it.
    let wire = serde_json::to_string(&done).unwrap();
    for material in ["BEGIN RSA", "MIIBOgIBAAJBAK", "whsec_a1b2c3d4e5"] {
        assert!(
            !wire.contains(material),
            "receipt leaked {material}: {wire}"
        );
    }
}

#[test]
fn a_provider_with_no_recipe_and_no_endpoint_leaves_the_user_where_they_started() {
    // The fallback ADR 0082's alternatives section insists on: a ceremony that
    // cannot run must leave the user the instructions they have today, not a
    // dead end. C3 is that state, and it is reachable rather than a gap.
    let unknown = ProviderCapability::none();
    for phase in Phase::ALL {
        assert_eq!(resolve(phase, unknown), Tier::Blocked, "{phase:?}");
    }
    assert!(!Tier::Blocked.drives_a_browser());
    assert!(!Tier::Blocked.uses_a_model());
}

#[test]
fn a_ceremony_nobody_is_watching_cannot_be_driven_by_a_model() {
    // ADR 0082 §4: the user is present by definition, because they are setting
    // the product up. §5 makes that a requirement rather than an assumption, so
    // a scheduler cannot start one overnight.
    let unattended = Guard::new(
        Presence::Absent,
        true,
        Consent::for_organizations(&["acme-corp"]),
    );
    assert_eq!(
        unattended.admit(Act::Navigate, None),
        Err(Refusal::UserNotPresent)
    );
    assert_eq!(
        unattended.admit(Act::Capture, None),
        Err(Refusal::UserNotPresent)
    );
}
