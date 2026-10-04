/// Keeps Windows awake while a queue is running without forcing the display on.
///
/// `SetThreadExecutionState` is thread-scoped, so the Windows implementation owns
/// a dedicated thread for the full lifetime of the guard. This avoids async task
/// migration accidentally clearing the request from a different runtime thread.
pub struct SleepInhibitor {
    #[cfg(target_os = "windows")]
    stop_tx: Option<std::sync::mpsc::Sender<()>>,
    #[cfg(target_os = "windows")]
    worker: Option<std::thread::JoinHandle<()>>,
}

impl SleepInhibitor {
    pub fn acquire() -> Result<Self, String> {
        #[cfg(target_os = "windows")]
        {
            use std::sync::mpsc;
            use std::time::Duration;
            use windows_sys::Win32::System::Power::{
                SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
            };

            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            let (stop_tx, stop_rx) = mpsc::channel();

            let worker = std::thread::Builder::new()
                .name("transcriber-sleep-inhibitor".to_string())
                .spawn(move || {
                    let ok = unsafe {
                        SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) != 0
                    };
                    let _ = ready_tx.send(ok);

                    if ok {
                        let _ = stop_rx.recv();
                        unsafe {
                            let _ = SetThreadExecutionState(ES_CONTINUOUS);
                        }
                    }
                })
                .map_err(|error| format!("Failed to start sleep inhibitor: {error}"))?;

            match ready_rx.recv_timeout(Duration::from_secs(2)) {
                Ok(true) => Ok(Self {
                    stop_tx: Some(stop_tx),
                    worker: Some(worker),
                }),
                Ok(false) => {
                    let _ = worker.join();
                    Err("Windows rejected the sleep-prevention request.".to_string())
                }
                Err(error) => {
                    let _ = stop_tx.send(());
                    let _ = worker.join();
                    Err(format!("Sleep inhibitor did not initialize: {error}"))
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            Ok(Self {})
        }
    }
}

impl Drop for SleepInhibitor {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        {
            if let Some(tx) = self.stop_tx.take() {
                let _ = tx.send(());
            }
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }
}
