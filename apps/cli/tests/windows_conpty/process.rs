use super::job::Job;
use std::ffi::{OsStr, OsString};
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use windows_sys::Win32::Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Console::HPCON;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTUPINFOEXW,
};

pub(super) fn failed(label: &'static str) -> io::Error {
    io::Error::other(label)
}

fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut value: Vec<_> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err(failed("NUL in terminal process parameter"));
    }
    value.push(0);
    Ok(value)
}

fn quoted(value: &OsStr) -> io::Result<Vec<u16>> {
    let value = wide(value)?;
    let mut output = vec![34];
    let mut slashes = 0;
    for &character in &value[..value.len() - 1] {
        if character == 92 {
            slashes += 1;
            continue;
        }
        output.extend(std::iter::repeat_n(
            92,
            if character == 34 {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        slashes = 0;
        output.push(character);
    }
    output.extend(std::iter::repeat_n(92, slashes * 2));
    output.push(34);
    Ok(output)
}

fn command(executable: &Path, arguments: &[OsString]) -> io::Result<Vec<u16>> {
    let mut output = quoted(executable.as_os_str())?;
    for argument in arguments {
        output.push(32);
        output.extend(quoted(argument)?);
    }
    if output.len() > 32_766 {
        return Err(failed("Oversized terminal command"));
    }
    output.push(0);
    Ok(output)
}

fn environment(home: &Path, probe: bool) -> io::Result<Vec<u16>> {
    let names = [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
    ];
    let mut entries: Vec<(OsString, OsString)> = names
        .into_iter()
        .filter_map(|name| std::env::var_os(name).map(|value| (name.into(), value)))
        .collect();
    entries.push(("HOME".into(), home.into()));
    entries.push(("USERPROFILE".into(), home.into()));
    entries.push(("GIT_CONFIG_NOSYSTEM".into(), "1".into()));
    entries.push(("GIT_TERMINAL_PROMPT".into(), "0".into()));
    entries.push((
        "GIT_CONFIG_GLOBAL".into(),
        home.join(".gitconfig").into_os_string(),
    ));
    if probe {
        entries.push(("OPENSESAME_TEST_CONPTY_MODE_PROBE".into(), "1".into()));
    }
    entries.sort_by_key(|(name, _)| name.to_string_lossy().to_ascii_lowercase());
    let mut output = Vec::new();
    for (name, value) in entries {
        let mut entry = name;
        entry.push("=");
        entry.push(value);
        output.extend(wide(&entry)?);
    }
    output.push(0);
    Ok(output)
}

struct Attributes {
    _words: Vec<usize>,
    pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    fn new(console: HPCON) -> io::Result<Self> {
        let mut bytes = 0;
        // SAFETY: null-list size query writes only the valid length pointer.
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut bytes);
        }
        if bytes == 0 || bytes > 65_536 {
            return Err(failed("Invalid ConPTY attribute size"));
        }
        let mut words = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let pointer = words.as_mut_ptr().cast();
        // SAFETY: aligned allocation remains live and is large enough for the queried list.
        if unsafe { InitializeProcThreadAttributeList(pointer, 1, 0, &mut bytes) } == 0 {
            return Err(failed("ConPTY attribute initialization failed"));
        }
        let attributes = Self {
            _words: words,
            pointer,
        };
        // SAFETY: initialized list and live HPCON; this attribute takes the HPCON value, not &HPCON.
        if unsafe {
            UpdateProcThreadAttribute(
                pointer,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                console as *const _,
                size_of::<HPCON>(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(failed("ConPTY process attachment failed"));
        }
        Ok(attributes)
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: owned initialized list, backing allocation still live until this drop returns.
        unsafe {
            DeleteProcThreadAttributeList(self.pointer);
        }
    }
}

pub(super) struct Child {
    job: Job,
    process: OwnedHandle,
}
impl Child {
    pub(super) fn spawn(
        console: HPCON,
        executable: &Path,
        arguments: &[OsString],
        home: &Path,
        probe: bool,
    ) -> io::Result<Self> {
        let job = Job::new()?;
        let attributes = Attributes::new(console)?;
        let application = wide(executable.as_os_str())?;
        let directory = wide(home.as_os_str())?;
        let mut command = command(executable, arguments)?;
        let environment = environment(home, probe)?;
        // SAFETY: Win32 POD structures support zero initialization before required fields are set.
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb =
            u32::try_from(size_of::<STARTUPINFOEXW>()).map_err(|_| failed("Startup size"))?;
        startup.lpAttributeList = attributes.pointer;
        // SAFETY: output-only Win32 POD, populated on successful process creation.
        let mut information: PROCESS_INFORMATION = unsafe { zeroed() };
        // SAFETY: all strings/buffers/list remain live for this synchronous call; no handle inheritance.
        if unsafe {
            CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                environment.as_ptr().cast(),
                directory.as_ptr(),
                &startup.StartupInfo,
                &mut information,
            )
        } == 0
        {
            return Err(failed("ConPTY CLI process creation failed"));
        }
        // SAFETY: successful CreateProcessW returns two newly owned handles.
        let process = unsafe { OwnedHandle::from_raw_handle(information.hProcess) };
        // SAFETY: successful creation returned a fresh owned primary thread handle.
        let thread = unsafe { OwnedHandle::from_raw_handle(information.hThread) };
        let child = Self { job, process };
        child.job.attach(&child.process)?;
        // SAFETY: primary thread is live and was created with exactly one suspension.
        if unsafe { ResumeThread(thread.as_raw_handle() as HANDLE) } != 1 {
            return Err(failed("Contained terminal child could not start"));
        }
        Ok(child)
    }
    pub(super) fn status(&self) -> io::Result<Option<u32>> {
        let handle = self.process.as_raw_handle() as HANDLE;
        // SAFETY: owned live process handle; zero-time bounded readiness query.
        match unsafe { WaitForSingleObject(handle, 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                // SAFETY: owned live process handle and valid output pointer.
                if unsafe { GetExitCodeProcess(handle, &mut code) } == 0 {
                    return Err(failed("CLI exit status unavailable"));
                }
                Ok(Some(code))
            }
            _ => Err(failed("CLI process wait failed")),
        }
    }
}
impl Drop for Child {
    fn drop(&mut self) {
        if !matches!(self.status(), Ok(Some(_))) {
            // SAFETY: owned fixture child only; cancellation never addresses another process.
            unsafe {
                let handle = self.process.as_raw_handle() as HANDLE;
                TerminateProcess(handle, 129);
                WaitForSingleObject(handle, 5_000);
            }
        }
    }
}
