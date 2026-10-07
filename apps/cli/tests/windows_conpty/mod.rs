mod drain;
mod job;
mod process;

use drain::{visible, Shared};
use process::{failed, Child};
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::os::windows::thread::JoinHandleExt;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, GetConsoleMode, GetStdHandle, COORD,
    ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT, ENABLE_PROCESSED_INPUT, HPCON, STD_INPUT_HANDLE,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::IO::CancelSynchronousIo;
use zeroize::Zeroizing;

const PROBE_TEST: &str = "windows_terminal_enrollment_management_and_real_recovery";
const DEADLINE: Duration = Duration::from_secs(60);

fn pipe() -> io::Result<(File, File)> {
    let mut read = std::ptr::null_mut();
    let mut write = std::ptr::null_mut();
    // SAFETY: valid output pointers, null attributes create non-inheritable fixture handles.
    if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 0) } == 0 {
        return Err(failed("ConPTY pipe creation failed"));
    }
    // SAFETY: successful CreatePipe returned two fresh owned handles.
    Ok(unsafe { (File::from_raw_handle(read), File::from_raw_handle(write)) })
}

pub fn mode_probe() {
    if std::env::var("OPENSESAME_TEST_CONPTY_MODE_PROBE").as_deref() != Ok("1") {
        return;
    }
    let mut mode = 0;
    // SAFETY: OS standard input handle is borrowed; output points to a valid local value.
    let valid = unsafe { GetConsoleMode(GetStdHandle(STD_INPUT_HANDLE), &mut mode) } != 0;
    let raw = mode & (ENABLE_ECHO_INPUT | ENABLE_LINE_INPUT | ENABLE_PROCESSED_INPUT) == 0;
    // The test-only helper observes OS mode; it cannot read secrets or grant owner authority.
    std::process::exit(if !valid {
        22
    } else if raw {
        0
    } else {
        21
    });
}

pub struct Result {
    pub code: u32,
    pub visible: Zeroizing<String>,
}

pub struct Terminal {
    console: HPCON,
    input: Option<File>,
    state: Shared,
    reader: Option<JoinHandle<()>>,
    child: Option<Child>,
    home: PathBuf,
    cursor: usize,
}
impl Terminal {
    pub fn spawn(executable: &Path, arguments: &[OsString], home: &Path) -> io::Result<Self> {
        let (console_input, input) = pipe()?;
        let (output, console_output) = pipe()?;
        let mut console = 0;
        // SAFETY: live pipe handles and valid output pointer; native API creates the pseudo-console.
        let status = unsafe {
            CreatePseudoConsole(
                COORD { X: 120, Y: 40 },
                console_input.as_raw_handle() as HANDLE,
                console_output.as_raw_handle() as HANDLE,
                0,
                &mut console,
            )
        };
        if status != 0 {
            return Err(failed("Actual ConPTY is unavailable"));
        }
        let (state, reader) = drain::start(output);
        // The pseudo-console has duplicated its input/output references. Extra writer references
        // must not survive shutdown or the reader will never see EOF.
        drop(console_input);
        drop(console_output);
        let mut terminal = Self {
            console,
            input: Some(input),
            state,
            reader: Some(reader),
            child: None,
            home: home.into(),
            cursor: 0,
        };
        terminal.child = Some(Child::spawn(console, executable, arguments, home, false)?);
        Ok(terminal)
    }

    pub fn answer(&mut self, prompt: &str, secret: &str) -> io::Result<()> {
        self.expect(prompt)?;
        self.wait_raw()?;
        let mut bytes = Zeroizing::new(secret.as_bytes().to_vec());
        bytes.push(b'\r');
        self.input
            .as_mut()
            .ok_or_else(|| failed("Terminal input closed"))?
            .write_all(&bytes)
    }

    pub fn interrupt(&mut self, prompt: &str) -> io::Result<()> {
        self.expect(prompt)?;
        self.wait_raw()?;
        self.input
            .as_mut()
            .ok_or_else(|| failed("Terminal input closed"))?
            .write_all(&[3])
    }

    fn expect(&mut self, prompt: &str) -> io::Result<()> {
        let deadline = Instant::now() + DEADLINE;
        loop {
            let output = visible(&self.state, false)?;
            if let Some(offset) = output.get(self.cursor..).and_then(|tail| tail.find(prompt)) {
                self.cursor += offset + prompt.len();
                return Ok(());
            }
            if self
                .child
                .as_ref()
                .ok_or_else(|| failed("Terminal child closed"))?
                .status()?
                .is_some()
            {
                return Err(failed("CLI ended before expected hidden prompt"));
            }
            if Instant::now() >= deadline {
                return Err(failed("Hidden prompt deadline exceeded"));
            }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait_raw(&self) -> io::Result<()> {
        let deadline = Instant::now() + DEADLINE;
        let executable = std::env::current_exe()?;
        let arguments = ["--exact", PROBE_TEST, "--nocapture"].map(OsString::from);
        loop {
            let probe = Child::spawn(self.console, &executable, &arguments, &self.home, true)?;
            let probe_deadline = Instant::now() + Duration::from_secs(5);
            let code = loop {
                if let Some(code) = probe.status()? {
                    break code;
                }
                if Instant::now() >= probe_deadline {
                    return Err(failed("Console mode probe stalled"));
                }
                thread::sleep(Duration::from_millis(5));
            };
            match code {
                0 => return Ok(()),
                21 if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
                _ => return Err(failed("Actual hidden console mode was not established")),
            }
        }
    }

    pub fn finish(mut self, protected: &[&str]) -> io::Result<Result> {
        let deadline = Instant::now() + DEADLINE;
        let code = loop {
            if let Some(code) = self
                .child
                .as_ref()
                .ok_or_else(|| failed("Terminal child closed"))?
                .status()?
            {
                break code;
            }
            if Instant::now() >= deadline {
                return Err(failed("Terminal process deadline exceeded"));
            }
            thread::sleep(Duration::from_millis(5));
        };
        self.shutdown()?;
        let output = visible(&self.state, true)?;
        if protected
            .iter()
            .any(|secret| !secret.is_empty() && output.contains(secret))
        {
            return Err(failed("Credential echo detected; terminal output withheld"));
        }
        Ok(Result {
            code,
            visible: output,
        })
    }

    fn shutdown(&mut self) -> io::Result<()> {
        self.child.take();
        self.input.take();
        drain::closing(&self.state);
        if self.console != 0 {
            let console = self.console;
            self.console = 0;
            let (finished, receiver) = mpsc::sync_channel(1);
            thread::spawn(move || {
                // SAFETY: transferred owned HPCON is closed exactly once; reader keeps draining.
                unsafe {
                    ClosePseudoConsole(console);
                }
                let _ = finished.send(());
            });
            receiver
                .recv_timeout(Duration::from_secs(30))
                .map_err(|_| failed("Pseudo-console shutdown stalled"))?;
        }
        if let Some(reader) = self.reader.take() {
            finish_reader(reader)?;
        }
        Ok(())
    }
}
impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn finish_reader(reader: JoinHandle<()>) -> io::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !reader.is_finished() {
        if Instant::now() >= deadline {
            // SAFETY: borrowed live reader thread handle; cancels only fixture I/O.
            unsafe {
                CancelSynchronousIo(reader.as_raw_handle() as HANDLE);
            }
            return Err(failed("Terminal drain shutdown stalled"));
        }
        thread::sleep(Duration::from_millis(5));
    }
    reader.join().map_err(|_| failed("Terminal drain failed"))
}
