#[cfg(unix)]
mod unix {
    use std::path::Path;

    use opensesame_cli_app_integration::{fingerprint_of_spki, RootTrustRecord};

    use crate::client::{open_via_guard, seal_via_guard, GuardOpen};
    use crate::test_support::MockGuard;

    #[test]
    fn seal_and_open_round_trip() {
        let state = tempfile::tempdir().expect("state");
        let mock = MockGuard::start(state.path());
        let socket = mock.socket_path();
        let record = RootTrustRecord::new(fingerprint_of_spki(b"root"), 1).expect("record");
        seal_via_guard(socket, &record, 0).expect("seal");
        let open = open_via_guard(socket).expect("open");
        match open {
            GuardOpen::Enrolled(loaded) => {
                assert_eq!(loaded.spki_fingerprint(), record.spki_fingerprint());
                assert_eq!(loaded.enrollment_epoch(), 1);
            }
            GuardOpen::Absent => panic!("expected enrolled"),
        }
    }

    #[test]
    fn rollback_epoch_is_refused() {
        let state = tempfile::tempdir().expect("state");
        let mock = MockGuard::start(state.path());
        let socket = mock.socket_path();
        let first = RootTrustRecord::new(fingerprint_of_spki(b"a"), 1).expect("record");
        seal_via_guard(socket, &first, 0).expect("seal");
        let bad = RootTrustRecord::new(fingerprint_of_spki(b"b"), 1).expect("record");
        assert!(seal_via_guard(socket, &bad, 0).is_err());
    }
}
