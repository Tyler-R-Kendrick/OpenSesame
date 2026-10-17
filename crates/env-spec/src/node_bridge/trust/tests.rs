use super::*;

/// The caller of every row: user 1000 in groups 1000 and 27.
fn caller() -> Caller {
    Caller {
        euid: 1000,
        groups: vec![1000, 27],
    }
}

const fn owner(uid: u32, gid: u32, mode: u32) -> Owner {
    Owner { uid, gid, mode }
}

#[test]
fn directories_are_trusted_or_refused_for_who_could_have_written_them() {
    // (what stat said, why it is refused or None when it is searched)
    let table = [
        // The layouts real machines produce.
        ("root:root 0755", owner(0, 0, 0o755), None),
        ("root:root 0775 (a CI image)", owner(0, 0, 0o775), None),
        ("root:root 0770", owner(0, 0, 0o770), None),
        ("user:user 0775 (umask 002)", owner(1000, 1000, 0o775), None),
        ("user:user 0700", owner(1000, 1000, 0o700), None),
        ("user:user 0755", owner(1000, 1000, 0o755), None),
        (
            "user:a supplementary group 0775",
            owner(1000, 27, 0o775),
            None,
        ),
        ("root:a supplementary group 0775", owner(0, 27, 0o775), None),
        // A group that is not the caller's can write: not the caller's directory.
        (
            "root:othergroup 0775",
            owner(0, 5000, 0o775),
            Some(Skip::GroupWritable(5000)),
        ),
        (
            "user:othergroup 0775",
            owner(1000, 5000, 0o775),
            Some(Skip::GroupWritable(5000)),
        ),
        // The same group cannot write it: whose group it is does not matter.
        ("root:othergroup 0755", owner(0, 5000, 0o755), None),
        // Anyone can write it.
        (
            "root:root 0777",
            owner(0, 0, 0o777),
            Some(Skip::WritableByOthers),
        ),
        (
            "user:user 0777",
            owner(1000, 1000, 0o777),
            Some(Skip::WritableByOthers),
        ),
        (
            "root:root 0757",
            owner(0, 0, 0o757),
            Some(Skip::WritableByOthers),
        ),
        (
            "root:root 1777 (sticky)",
            owner(0, 0, 0o1777),
            Some(Skip::WritableByOthers),
        ),
        (
            "root:root 0702",
            owner(0, 0, 0o702),
            Some(Skip::WritableByOthers),
        ),
        // Someone else owns it, however it is moded.
        (
            "uid 1001 0755",
            owner(1001, 1000, 0o755),
            Some(Skip::OwnedBy(1001)),
        ),
        (
            "uid 1001 0700",
            owner(1001, 1001, 0o700),
            Some(Skip::OwnedBy(1001)),
        ),
        (
            "uid 1001 0777",
            owner(1001, 1000, 0o777),
            Some(Skip::OwnedBy(1001)),
        ),
    ];
    for (label, stat, want) in table {
        assert_eq!(directory(stat, &caller()), want, "{label}");
    }
}

#[test]
fn a_caller_that_is_root_trusts_root_and_itself_only() {
    let root = Caller {
        euid: 0,
        groups: vec![0],
    };
    assert_eq!(directory(owner(0, 0, 0o775), &root), None);
    assert_eq!(
        directory(owner(1000, 1000, 0o755), &root),
        Some(Skip::OwnedBy(1000))
    );
    assert_eq!(
        directory(owner(0, 27, 0o775), &root),
        Some(Skip::GroupWritable(27))
    );
}

#[test]
fn a_node_file_is_held_to_the_rule_its_directory_is() {
    let table = [
        ("root 0755", owner(0, 0, 0o755), None),
        ("root 0775", owner(0, 0, 0o775), None),
        ("user 0775 (umask 002)", owner(1000, 1000, 0o775), None),
        ("user 0700", owner(1000, 1000, 0o700), None),
        (
            "user:a supplementary group 0664",
            owner(1000, 27, 0o664),
            None,
        ),
        // A group the caller is not in can write it: not the caller's file.
        (
            "root:othergroup 0775",
            owner(0, 5000, 0o775),
            Some(Skip::GroupWritable(5000)),
        ),
        (
            "user:othergroup 0664",
            owner(1000, 5000, 0o664),
            Some(Skip::GroupWritable(5000)),
        ),
        // The same group cannot write it: whose group it is does not matter.
        ("root:othergroup 0755", owner(0, 5000, 0o755), None),
        (
            "root 0777",
            owner(0, 0, 0o777),
            Some(Skip::WritableByOthers),
        ),
        (
            "user 0757",
            owner(1000, 1000, 0o757),
            Some(Skip::WritableByOthers),
        ),
        (
            "uid 1001 0755",
            owner(1001, 1001, 0o755),
            Some(Skip::OwnedBy(1001)),
        ),
    ];
    for (label, stat, want) in table {
        assert_eq!(file(stat, &caller()), want, "{label}");
    }
}

#[test]
fn each_refusal_says_exactly_why() {
    assert_eq!(Skip::WritableByOthers.reason(), "writable by others");
    assert_eq!(
        Skip::GroupWritable(1234).reason(),
        "group-writable by group 1234 which is not one of yours"
    );
    assert_eq!(Skip::OwnedBy(1001).reason(), "owned by uid 1001");
    assert_eq!(Skip::Empty.reason(), "empty entry");
    assert_eq!(Skip::Relative.reason(), "relative");
}

#[cfg(unix)]
#[test]
fn the_current_caller_is_in_its_own_effective_group() {
    let me = Caller::current();
    // SAFETY: `geteuid` and `getegid` take nothing and cannot fail.
    let (user, group) = unsafe { (libc::geteuid(), libc::getegid()) };
    assert_eq!(me.euid, user);
    assert!(me.groups.contains(&group), "{:?}", me.groups);
}
