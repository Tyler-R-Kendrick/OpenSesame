//! Declaration: only a login field of an exact https action may become a
//! substitution site. Rotation keeps ADR 0076 §6 — a page that hashes a
//! password-set field would turn a surrogate into a new password nobody holds
//! — so a password-set field has no way to obtain a substitution at all.

#![cfg(feature = "login-surrogate")]

mod login_support;

use login_support::{control, spec, ENTROPY, SURROGATE};
use opensesame_rotation_web::{
    ChangePasswordRecipe, DeclareError, LoginSubstitution, SubstitutionPurpose, SURROGATE_HEX_LEN,
    SURROGATE_MARKER,
};

fn declare_field(field: &str) -> Result<LoginSubstitution, DeclareError> {
    LoginSubstitution::declare(spec(field), ENTROPY)
}

#[test]
fn a_login_field_is_declared_for_login_only() {
    let substitution = declare_field("password").unwrap();
    assert_eq!(substitution.purpose(), SubstitutionPurpose::Login);
    assert_eq!(substitution.origin().to_string(), "https://login.example");
    assert_eq!(substitution.action_path(), "/session");
    assert_eq!(substitution.field(), "password");
    let surrogate = substitution.surrogate().as_str();
    assert_eq!(surrogate, SURROGATE);
    assert_eq!(surrogate.len(), SURROGATE_MARKER.len() + SURROGATE_HEX_LEN);
}

#[test]
fn a_new_password_autocomplete_field_cannot_obtain_a_substitution() {
    for token in [
        "new-password",
        "NEW-PASSWORD",
        "section-change new-password",
    ] {
        let mut declared = spec("password");
        declared.control = control("#pw", Some(token));
        assert_eq!(
            LoginSubstitution::declare(declared, ENTROPY).unwrap_err(),
            DeclareError::PasswordSetField,
            "{token}"
        );
    }
}

#[test]
fn a_password_set_field_name_cannot_obtain_a_substitution() {
    for field in [
        "new_password",
        "newPassword",
        "new-password",
        "password_confirmation",
        "confirmPassword",
        "password2_repeat",
        "retype_password",
        "passwordAgain",
        "user[new_pwd]",
    ] {
        assert_eq!(
            declare_field(field).unwrap_err(),
            DeclareError::PasswordSetField,
            "{field}"
        );
    }
}

#[test]
fn a_password_set_field_named_marker_last_cannot_obtain_a_substitution() {
    // The marker after the password word, and Django's password1/password2.
    for field in [
        "password_new",
        "passwordNew",
        "pwd_new",
        "passwordVerify",
        "password1",
        "password2",
        "passwd2",
        "resetPassword",
        "createPassword",
        "choose_password",
        "user[password][new]",
    ] {
        assert_eq!(
            declare_field(field).unwrap_err(),
            DeclareError::PasswordSetField,
            "{field}"
        );
        let mut declared = spec("password");
        declared.control = control(&format!("input[name={field}]"), None);
        assert_eq!(
            LoginSubstitution::declare(declared, ENTROPY).unwrap_err(),
            DeclareError::PasswordSetField,
            "selector {field}"
        );
    }
}

#[test]
fn ordinary_login_field_names_are_declared() {
    for field in [
        "password",
        "passwd",
        "Passwd",
        "pass",
        "pwd",
        "user[password]",
        "session[password]",
        "login_password",
        "j_password",
        "currentPassword",
    ] {
        let mut declared = spec(field);
        declared.control = control(
            "form.fieldset-login input[type=password]",
            Some("current-password"),
        );
        assert!(
            LoginSubstitution::declare(declared, ENTROPY).is_ok(),
            "{field}"
        );
    }
}

#[test]
fn a_rotation_recipes_password_set_selectors_cannot_obtain_a_substitution() {
    // The selectors a change-password recipe fills with the candidate. A login
    // declaration pointed at either is refused, whatever the wire name says.
    let recipe = ChangePasswordRecipe {
        change_url: "https://login.example/settings/password".into(),
        current_password_selector: Some("#current-password".into()),
        new_password_selector: "#new-password".into(),
        confirm_password_selector: Some("input[name=confirm]".into()),
        submit_selector: "button[type=submit]".into(),
    };
    let set_selectors = [
        recipe.new_password_selector.as_str(),
        recipe.confirm_password_selector.as_deref().unwrap(),
    ];
    for selector in set_selectors {
        let mut declared = spec("password");
        declared.control = control(selector, None);
        assert_eq!(
            LoginSubstitution::declare(declared, ENTROPY).unwrap_err(),
            DeclareError::PasswordSetField,
            "{selector}"
        );
    }
}

#[test]
fn a_cleartext_or_inexact_origin_is_refused() {
    for origin in [
        "http://login.example",
        "https://login.example/",
        "https://login.example/session",
        "https://user@login.example",
        "login.example",
    ] {
        let mut declared = spec("password");
        declared.origin = origin.into();
        assert_eq!(
            LoginSubstitution::declare(declared, ENTROPY).unwrap_err(),
            DeclareError::Origin,
            "{origin}"
        );
    }
}

#[test]
fn an_inexact_action_path_is_refused() {
    for path in [
        "session",
        "",
        "/session?next=/",
        "/session#x",
        "/a/../session",
        "/a/%2e%2e/session",
        "/./session",
        "/ses sion",
    ] {
        let mut declared = spec("password");
        declared.action_path = path.into();
        assert_eq!(
            LoginSubstitution::declare(declared, ENTROPY).unwrap_err(),
            DeclareError::ActionPath,
            "{path:?}"
        );
    }
}

#[test]
fn an_empty_or_surrogate_shaped_field_is_refused() {
    assert_eq!(declare_field("").unwrap_err(), DeclareError::EmptyField);
    assert_eq!(
        declare_field(SURROGATE).unwrap_err(),
        DeclareError::EmptyField
    );
}

#[test]
fn zeroed_entropy_is_refused() {
    for entropy in [[0u8; 16], [0xff; 16]] {
        assert_eq!(
            LoginSubstitution::declare(spec("password"), entropy).unwrap_err(),
            DeclareError::WeakEntropy
        );
    }
}
