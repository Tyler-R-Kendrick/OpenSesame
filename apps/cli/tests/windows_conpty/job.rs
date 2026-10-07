use super::process::failed;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub(super) struct Job(OwnedHandle);
impl Job {
    pub(super) fn new() -> io::Result<Self> {
        // SAFETY: null attributes and name create one private unnamed job handle.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(failed("Private terminal job unavailable"));
        }
        // SAFETY: successful job creation returned a fresh owned handle.
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        // SAFETY: Win32 POD supports zero initialization before the required flag is set.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let bytes = u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
            .map_err(|_| failed("Terminal job limits oversized"))?;
        // SAFETY: live owned job, valid fixed-size limits buffer, synchronous native call.
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                bytes,
            )
        } == 0
        {
            return Err(failed("Private terminal job limits failed"));
        }
        Ok(job)
    }

    pub(super) fn attach(&self, process: &OwnedHandle) -> io::Result<()> {
        // SAFETY: both handles are live owned fixture objects; process is still suspended.
        if unsafe {
            AssignProcessToJobObject(
                self.0.as_raw_handle() as HANDLE,
                process.as_raw_handle() as HANDLE,
            )
        } == 0
        {
            return Err(failed("CLI descendant containment unavailable"));
        }
        Ok(())
    }
}
