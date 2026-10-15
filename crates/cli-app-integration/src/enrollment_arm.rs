//! Host-armed enrollment window (D7-2 residual: race on armed enroll).

use std::time::Duration;

/// Default enrollment arming TTL after an OS prompt on the operator path.
pub const ENROLLMENT_ARM_TTL_SECS: u64 = 120;

#[derive(Clone, Copy, Debug, Default)]
pub struct EnrollmentArm {
    armed_until_unix: u64,
}

impl EnrollmentArm {
    #[must_use]
    pub fn is_armed(&self, now_unix: u64) -> bool {
        self.armed_until_unix > now_unix
    }

    pub fn arm(&mut self, now_unix: u64, ttl_secs: u64) {
        self.armed_until_unix = now_unix.saturating_add(ttl_secs);
    }

    pub fn disarm(&mut self) {
        self.armed_until_unix = 0;
    }

    #[must_use]
    pub fn ttl_default() -> Duration {
        Duration::from_secs(ENROLLMENT_ARM_TTL_SECS)
    }
}
