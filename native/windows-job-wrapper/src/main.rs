#[cfg(not(windows))]
fn main() {
    eprintln!("codex-infinite-job-wrapper is Windows-only");
    std::process::exit(2);
}

#[cfg(windows)]
mod windows_wrapper {
    use std::ffi::{OsStr, OsString, c_void};
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::{null, null_mut};
    use std::thread;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        CREATE_SUSPENDED, CreateEventW, CreateProcessW, GetCurrentProcessId, GetExitCodeProcess,
        OpenEventW, OpenProcess, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES,
        STARTUPINFOW, SetEvent, TerminateProcess, WaitForSingleObject,
    };

    const EVENT_MODIFY_STATE: u32 = 0x0002;
    const SYNCHRONIZE: u32 = 0x0010_0000;

    struct OwnedHandle(HANDLE);

    impl OwnedHandle {
        fn new(handle: HANDLE, label: &str) -> Result<Self, String> {
            if handle.is_null() {
                return Err(last_error(label));
            }
            Ok(Self(handle))
        }

        fn get(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    fn last_error(context: &str) -> String {
        format!("{context} failed with Win32 error {}", unsafe {
            GetLastError()
        })
    }

    fn quote_argument(value: &OsStr) -> Result<Vec<u16>, String> {
        let input: Vec<u16> = value.encode_wide().collect();
        if input.contains(&0) {
            return Err("arguments cannot contain NUL".to_owned());
        }
        let mut output = vec![b'"' as u16];
        let mut slashes = 0usize;
        for unit in input {
            if unit == b'\\' as u16 {
                slashes += 1;
                continue;
            }
            if unit == b'"' as u16 {
                output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2 + 1));
            } else {
                output.extend(std::iter::repeat_n(b'\\' as u16, slashes));
            }
            slashes = 0;
            output.push(unit);
        }
        output.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
        output.push(b'"' as u16);
        Ok(output)
    }

    fn command_line(program: &OsStr, arguments: &[OsString]) -> Result<Vec<u16>, String> {
        let mut output = quote_argument(program)?;
        for argument in arguments {
            output.push(b' ' as u16);
            output.extend(quote_argument(argument)?);
        }
        output.push(0);
        Ok(output)
    }

    fn active_job_processes(job: HANDLE) -> Result<u32, String> {
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
        let ok = unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                (&raw mut accounting).cast::<c_void>(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(last_error("QueryInformationJobObject"));
        }
        Ok(accounting.ActiveProcesses)
    }

    fn terminate_and_drain(job: HANDLE, exit_code: u32) -> Result<(), String> {
        if unsafe { TerminateJobObject(job, exit_code) } == 0 {
            return Err(last_error("TerminateJobObject"));
        }
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if active_job_processes(job)? == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("job processes did not terminate within 8 seconds".to_owned());
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    fn stop_event_name(pid: u32) -> Vec<u16> {
        OsStr::new(&format!("Local\\CodexInfiniteStop-{pid}"))
            .encode_wide()
            .chain(Some(0))
            .collect()
    }

    fn signal_stop(pid: u32) -> Result<i32, String> {
        let name = stop_event_name(pid);
        let event = OwnedHandle::new(
            unsafe { OpenEventW(EVENT_MODIFY_STATE | SYNCHRONIZE, 0, name.as_ptr()) },
            "OpenEventW(stop)",
        )?;
        if unsafe { SetEvent(event.get()) } == 0 {
            return Err(last_error("SetEvent(stop)"));
        }
        Ok(0)
    }

    fn parse_arguments() -> Result<(u32, OsString, Vec<OsString>), String> {
        let mut values = std::env::args_os().skip(1);
        if values.next().as_deref() != Some(OsStr::new("--parent-pid")) {
            return Err("usage: wrapper --parent-pid PID -- PROGRAM [ARGS...]".to_owned());
        }
        let parent = values
            .next()
            .ok_or_else(|| "missing parent PID".to_owned())?;
        let parent_pid = parent
            .to_string_lossy()
            .parse::<u32>()
            .map_err(|_| "invalid parent PID".to_owned())?;
        if values.next().as_deref() != Some(OsStr::new("--")) {
            return Err("missing -- separator".to_owned());
        }
        let program = values.next().ok_or_else(|| "missing program".to_owned())?;
        Ok((parent_pid, program, values.collect()))
    }

    pub fn run() -> Result<i32, String> {
        let raw: Vec<OsString> = std::env::args_os().skip(1).collect();
        if raw.first().is_some_and(|value| value == "--stop") {
            if raw.len() != 2 {
                return Err("usage: wrapper --stop PID".to_owned());
            }
            let pid = raw[1]
                .to_string_lossy()
                .parse::<u32>()
                .map_err(|_| "invalid stop PID".to_owned())?;
            return signal_stop(pid);
        }
        let (parent_pid, program, arguments) = parse_arguments()?;
        let parent = OwnedHandle::new(
            unsafe { OpenProcess(0x0010_0000, 0, parent_pid) },
            "OpenProcess(parent)",
        )?;
        let job = OwnedHandle::new(
            unsafe { CreateJobObjectW(null(), null()) },
            "CreateJobObjectW",
        )?;

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job.get(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(last_error("SetInformationJobObject"));
        }
        let stop_name = stop_event_name(unsafe { GetCurrentProcessId() });
        let stop_event = OwnedHandle::new(
            unsafe { CreateEventW(null(), 1, 0, stop_name.as_ptr()) },
            "CreateEventW(stop)",
        )?;

        let mut program_wide: Vec<u16> = program.encode_wide().chain(Some(0)).collect();
        let mut command = command_line(&program, &arguments)?;
        let mut startup: STARTUPINFOW = unsafe { zeroed() };
        startup.cb = size_of::<STARTUPINFOW>() as u32;
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
        startup.hStdOutput = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
        startup.hStdError = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
        let mut process: PROCESS_INFORMATION = unsafe { zeroed() };
        let created = unsafe {
            CreateProcessW(
                program_wide.as_mut_ptr(),
                command.as_mut_ptr(),
                null(),
                null(),
                1,
                CREATE_SUSPENDED,
                null(),
                null(),
                &startup,
                &raw mut process,
            )
        };
        if created == 0 {
            return Err(last_error("CreateProcessW"));
        }
        let child_process = OwnedHandle::new(process.hProcess, "child process handle")?;
        let child_thread = OwnedHandle::new(process.hThread, "child thread handle")?;
        if unsafe { AssignProcessToJobObject(job.get(), child_process.get()) } == 0 {
            unsafe { TerminateProcess(child_process.get(), 125) };
            return Err(last_error("AssignProcessToJobObject"));
        }
        if unsafe { ResumeThread(child_thread.get()) } == u32::MAX {
            unsafe { TerminateProcess(child_process.get(), 125) };
            return Err(last_error("ResumeThread"));
        }

        loop {
            let child_wait = unsafe { WaitForSingleObject(child_process.get(), 50) };
            if child_wait == WAIT_OBJECT_0 {
                let mut exit_code = 1u32;
                if unsafe { GetExitCodeProcess(child_process.get(), &raw mut exit_code) } == 0 {
                    return Err(last_error("GetExitCodeProcess"));
                }
                terminate_and_drain(job.get(), exit_code)?;
                return Ok(exit_code as i32);
            }
            if child_wait != WAIT_TIMEOUT {
                return Err(last_error("WaitForSingleObject(child)"));
            }
            let parent_wait = unsafe { WaitForSingleObject(parent.get(), 0) };
            if parent_wait == WAIT_OBJECT_0 {
                terminate_and_drain(job.get(), 125)?;
                return Ok(125);
            }
            if parent_wait != WAIT_TIMEOUT {
                return Err(last_error("WaitForSingleObject(parent)"));
            }
            let stop_wait = unsafe { WaitForSingleObject(stop_event.get(), 0) };
            if stop_wait == WAIT_OBJECT_0 {
                terminate_and_drain(job.get(), 125)?;
                return Ok(125);
            }
            if stop_wait != WAIT_TIMEOUT {
                return Err(last_error("WaitForSingleObject(stop)"));
            }
        }
    }
}

#[cfg(windows)]
fn main() {
    match windows_wrapper::run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(125);
        }
    }
}
