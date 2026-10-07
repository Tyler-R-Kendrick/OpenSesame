use super::journey::Journey;
use zeroize::Zeroizing;

pub(super) fn run() {
    let journey = Journey::new();
    journey.initialize_historical_passwords();
    let id = journey.enroll(&journey.second, true);
    let before = journey.snapshot();
    let wrong = Zeroizing::new(uuid::Uuid::new_v4().to_string());
    for arguments in [
        vec!["security", "retired", "status"],
        vec!["security", "retired", "remove", &id],
        vec!["security", "retired", "clear-events"],
    ] {
        for credential in [wrong.as_str(), journey.second.as_str()] {
            assert!(
                journey
                    .run(&arguments, &[("Current store passphrase", credential)])
                    .code
                    != 0,
                "wrong management owner admitted"
            );
            before.assert_all_unchanged(&journey);
        }
    }
    let enroll = [
        "security",
        "retired",
        "enroll",
        "--acknowledge-verifier-risk",
    ];
    for (owner, retired) in [
        (wrong.as_str(), journey.first.as_str()),
        (journey.current.as_str(), journey.current.as_str()),
        (journey.current.as_str(), journey.second.as_str()),
    ] {
        assert!(
            journey
                .run(
                    &enroll,
                    &[
                        ("Current store passphrase", owner),
                        ("Selected retired passphrase", retired)
                    ]
                )
                .code
                != 0,
            "invalid terminal enrollment changed policy"
        );
        before.assert_all_unchanged(&journey);
    }
    assert!(
        journey.current(&["security", "retired", "enroll"]).code != 0,
        "risk acknowledgement omitted"
    );
    before.assert_all_unchanged(&journey);
    for selected_prompt in [false, true] {
        let mut terminal = journey
            .terminal(&enroll)
            .expect("terminal interrupt fixture unavailable");
        if selected_prompt {
            terminal
                .answer("Current store passphrase", &journey.current)
                .expect("fresh current prompt failed");
        }
        terminal
            .interrupt(if selected_prompt {
                "Selected retired passphrase"
            } else {
                "Current store passphrase"
            })
            .expect("actual terminal interrupt failed");
        let result = terminal
            .finish(&[&journey.first, &journey.second, &journey.current])
            .expect("interrupt completion/privacy failed");
        assert!(result.code != 0, "cancelled terminal management succeeded");
        before.assert_all_unchanged(&journey);
    }
    assert!(
        journey
            .read(&journey.current, &["show", "Owner/private", "--reveal"])
            .code
            == 0,
        "owner unavailable after failed management"
    );
    before.assert_all_unchanged(&journey);
}
