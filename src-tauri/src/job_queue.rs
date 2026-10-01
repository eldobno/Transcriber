use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

use crate::transcribe::probe_file_metadata;

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Inspecting,
    Ready,
    Queued,
    Converting,
    Transcribing,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueJob {
    pub id: String,
    pub source_path: String,
    pub file_name: String,
    pub format: String,
    pub size: String,
    pub duration_sec: f64,
    pub status: JobStatus,
    pub progress: f64,
    pub message: Option<String>,
    pub output_files: Vec<String>,
    pub error: Option<String>,
    pub duration_ms: Option<u64>,
    pub speed_factor: Option<f64>,
    pub created_at_ms: u64,

    #[serde(skip)]
    pub cancel_requested: bool,
}

#[derive(Debug, Default)]
pub struct JobQueue {
    pub jobs: Vec<QueueJob>,
    pub running: bool,
}

#[derive(Clone)]
pub struct JobQueueState(pub Arc<Mutex<JobQueue>>);

impl JobQueueState {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(JobQueue::default())))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobQueueSnapshot {
    pub jobs: Vec<QueueJob>,
    pub running: bool,
    pub total_duration_sec: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddJobsResult {
    pub queue: JobQueueSnapshot,
    pub ignored_paths: Vec<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn new_job_id() -> String {
    let sequence = NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed);
    format!("job-{}-{}", now_ms(), sequence)
}

fn snapshot(queue: &JobQueue) -> JobQueueSnapshot {
    JobQueueSnapshot {
        jobs: queue.jobs.clone(),
        running: queue.running,
        total_duration_sec: queue
            .jobs
            .iter()
            .filter(|job| job.status != JobStatus::Cancelled)
            .map(|job| job.duration_sec)
            .sum(),
    }
}

fn emit_queue(app: &AppHandle, queue: &JobQueue) {
    let _ = app.emit("job-queue-updated", snapshot(queue));
}

fn path_key(path: &str) -> String {
    let resolved = std::fs::canonicalize(path)
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .to_string();

    #[cfg(target_os = "windows")]
    {
        resolved.to_lowercase()
    }

    #[cfg(not(target_os = "windows"))]
    {
        resolved
    }
}

fn is_supported_media(path: &str) -> bool {
    let extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_lowercase();

    crate::AUDIO_EXTENSIONS.contains(&extension.as_str())
        || crate::VIDEO_EXTENSIONS.contains(&extension.as_str())
}

#[tauri::command]
pub fn get_job_queue(state: State<'_, JobQueueState>) -> Result<JobQueueSnapshot, String> {
    let queue = state
        .0
        .lock()
        .map_err(|error| format!("Queue lock error: {error}"))?;

    Ok(snapshot(&queue))
}

#[tauri::command]
pub async fn add_job_queue_files(
    app: AppHandle,
    state: State<'_, JobQueueState>,
    paths: Vec<String>,
) -> Result<AddJobsResult, String> {
    let mut ignored_paths = Vec::new();

    for path in paths {
        if !is_supported_media(&path) {
            ignored_paths.push(path);
            continue;
        }

        let key = path_key(&path);

        let job_id = {
            let mut queue = state
                .0
                .lock()
                .map_err(|error| format!("Queue lock error: {error}"))?;

            let duplicate = queue
                .jobs
                .iter()
                .any(|job| path_key(&job.source_path) == key);

            if duplicate {
                // Duplicate drops are deliberately ignored silently.
                continue;
            }

            let file_name = Path::new(&path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            let id = new_job_id();

            queue.jobs.push(QueueJob {
                id: id.clone(),
                source_path: path.clone(),
                file_name,
                format: String::new(),
                size: String::new(),
                duration_sec: 0.0,
                status: JobStatus::Inspecting,
                progress: 0.0,
                message: Some("Inspecting media".to_string()),
                output_files: Vec::new(),
                error: None,
                duration_ms: None,
                speed_factor: None,
                created_at_ms: now_ms(),
                cancel_requested: false,
            });

            emit_queue(&app, &queue);

            id
        };

        let metadata = probe_file_metadata(Some(&app), &path).await;

        let mut queue = state
            .0
            .lock()
            .map_err(|error| format!("Queue lock error: {error}"))?;

        if let Some(job) = queue.jobs.iter_mut().find(|job| job.id == job_id) {
            // A cancellation can arrive while ffprobe is still inspecting the file.
            // Do not let the inspection result resurrect a cancelled job.
            if job.cancel_requested {
                job.status = JobStatus::Cancelled;
                job.progress = 0.0;
                job.message = Some("Cancelled".to_string());
                job.error = None;
            } else {
                job.file_name = metadata.name;
                job.format = metadata.format;
                job.size = metadata.size;
                job.duration_sec = metadata.duration_sec;

                if metadata.exists {
                    job.status = JobStatus::Ready;
                    job.message = Some("Ready".to_string());
                    job.error = None;
                } else {
                    job.status = JobStatus::Failed;
                    job.message = Some("Problem".to_string());
                    job.error = Some("The source file no longer exists.".to_string());
                }
            }
        }

        emit_queue(&app, &queue);
    }

    let queue = state
        .0
        .lock()
        .map_err(|error| format!("Queue lock error: {error}"))?;

    Ok(AddJobsResult {
        queue: snapshot(&queue),
        ignored_paths,
    })
}

#[tauri::command]
pub fn move_queue_job(
    app: AppHandle,
    state: State<'_, JobQueueState>,
    job_id: String,
    new_index: usize,
) -> Result<JobQueueSnapshot, String> {
    let mut queue = state
        .0
        .lock()
        .map_err(|error| format!("Queue lock error: {error}"))?;

    let old_index = queue
        .jobs
        .iter()
        .position(|job| job.id == job_id)
        .ok_or_else(|| "Queue job not found.".to_string())?;

    let status = queue.jobs[old_index].status.clone();

    if matches!(status, JobStatus::Converting | JobStatus::Transcribing) {
        return Err("The active job cannot be reordered.".to_string());
    }

    let job = queue.jobs.remove(old_index);
    let target = new_index.min(queue.jobs.len());
    queue.jobs.insert(target, job);

    emit_queue(&app, &queue);

    Ok(snapshot(&queue))
}

#[tauri::command]
pub fn remove_queue_job(
    app: AppHandle,
    state: State<'_, JobQueueState>,
    job_id: String,
) -> Result<JobQueueSnapshot, String> {
    let mut queue = state
        .0
        .lock()
        .map_err(|error| format!("Queue lock error: {error}"))?;

    let index = queue
        .jobs
        .iter()
        .position(|job| job.id == job_id)
        .ok_or_else(|| "Queue job not found.".to_string())?;

    if matches!(
        queue.jobs[index].status,
        JobStatus::Converting | JobStatus::Transcribing
    ) {
        return Err("The active job cannot be removed.".to_string());
    }

    queue.jobs.remove(index);

    emit_queue(&app, &queue);

    Ok(snapshot(&queue))
}

#[tauri::command]
pub fn clear_job_queue(
    app: AppHandle,
    state: State<'_, JobQueueState>,
) -> Result<JobQueueSnapshot, String> {
    let mut queue = state
        .0
        .lock()
        .map_err(|error| format!("Queue lock error: {error}"))?;

    queue
        .jobs
        .retain(|job| matches!(job.status, JobStatus::Converting | JobStatus::Transcribing));

    emit_queue(&app, &queue);

    Ok(snapshot(&queue))
}

#[tauri::command]
pub async fn cancel_queue_job(
    app: AppHandle,
    state: State<'_, JobQueueState>,
    session_state: State<'_, crate::TranscriptionState>,
    job_id: String,
) -> Result<JobQueueSnapshot, String> {
    let should_cancel_session = {
        let mut queue = state
            .0
            .lock()
            .map_err(|error| format!("Queue lock error: {error}"))?;

        let job = queue
            .jobs
            .iter_mut()
            .find(|job| job.id == job_id)
            .ok_or_else(|| "Queue job not found.".to_string())?;

        let active = matches!(job.status, JobStatus::Converting | JobStatus::Transcribing);

        match job.status {
            JobStatus::Inspecting | JobStatus::Ready | JobStatus::Queued => {
                job.cancel_requested = true;
                job.status = JobStatus::Cancelled;
                job.progress = 0.0;
                job.message = Some("Cancelled".to_string());
                job.error = None;
            }

            JobStatus::Converting | JobStatus::Transcribing => {
                job.cancel_requested = true;
                job.message = Some("Cancelling...".to_string());
            }

            JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled => {
                return Ok(snapshot(&queue));
            }
        }

        emit_queue(&app, &queue);
        active
    };

    if should_cancel_session {
        // There is a very small gap between conversion and transcription where
        // the queue still looks active but the shared transcription session has
        // already returned to Idle. In that case the queue-level cancellation
        // flag is enough; start_job_queue checks it before starting Whisper.
        if let Err(error) = crate::cancel_transcription_session(session_state.0.clone()).await {
            if !error.contains("No active transcription or translation session") {
                return Err(error);
            }
        }
    }

    let queue = state
        .0
        .lock()
        .map_err(|error| format!("Queue lock error: {error}"))?;

    Ok(snapshot(&queue))
}

fn looks_cancelled(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("cancel") || error.contains("aborted")
}

#[tauri::command]
pub async fn start_job_queue(
    app: AppHandle,
    state: State<'_, JobQueueState>,
    log_state: State<'_, crate::LogState>,
    session_state: State<'_, crate::TranscriptionState>,
    settings: crate::settings::WhisperSettings,
) -> Result<JobQueueSnapshot, String> {
    let queue_state = state.0.clone();
    let logs = log_state.0.clone();
    let session = session_state.0.clone();

    // Turn all Ready jobs into queued work.
    {
        let mut queue = queue_state
            .lock()
            .map_err(|error| format!("Queue lock error: {error}"))?;

        if queue.running {
            return Err("The job queue is already running.".to_string());
        }

        let mut has_work = false;

        for job in &mut queue.jobs {
            if job.status == JobStatus::Ready && !job.cancel_requested {
                job.status = JobStatus::Queued;
                job.progress = 0.0;
                job.message = Some("Queued".to_string());
                job.error = None;
                has_work = true;
            } else if job.status == JobStatus::Queued && !job.cancel_requested {
                has_work = true;
            }
        }

        if !has_work {
            return Ok(snapshot(&queue));
        }

        queue.running = true;
        emit_queue(&app, &queue);
    }

    loop {
        // Pick exactly one queued job.
        let next_job = {
            let mut queue = queue_state
                .lock()
                .map_err(|error| format!("Queue lock error: {error}"))?;

            let Some(index) = queue
                .jobs
                .iter()
                .position(|job| job.status == JobStatus::Queued && !job.cancel_requested)
            else {
                queue.running = false;
                emit_queue(&app, &queue);
                return Ok(snapshot(&queue));
            };

            let job = &mut queue.jobs[index];

            job.status = JobStatus::Converting;
            job.progress = 0.0;
            job.message = Some("Converting media".to_string());
            job.error = None;

            let data = (job.id.clone(), job.source_path.clone(), job.duration_sec);

            emit_queue(&app, &queue);

            data
        };

        let (job_id, source_path, duration_sec) = next_job;

        // ----------------------------------------------------
        // Existing Whisper Desktop FFmpeg pipeline
        // ----------------------------------------------------

        let wav_path = match crate::transcribe::convert_to_wav(
            app.clone(),
            logs.clone(),
            session.clone(),
            source_path.clone(),
        )
        .await
        {
            Ok(path) => path,

            Err(error) => {
                let mut queue = queue_state
                    .lock()
                    .map_err(|lock_error| format!("Queue lock error: {lock_error}"))?;

                if let Some(job) = queue.jobs.iter_mut().find(|job| job.id == job_id) {
                    if job.cancel_requested || looks_cancelled(&error) {
                        job.status = JobStatus::Cancelled;
                        job.progress = 0.0;
                        job.message = Some("Cancelled".to_string());
                        job.error = None;
                    } else {
                        job.status = JobStatus::Failed;
                        job.message = Some("Conversion failed".to_string());
                        job.error = Some(error);
                    }
                }

                // A failed file must NOT stop the rest of the queue.
                emit_queue(&app, &queue);
                continue;
            }
        };

        // ----------------------------------------------------
        // Conversion succeeded → transcription begins
        // ----------------------------------------------------

        // Cancellation can land in the tiny interval after FFmpeg finishes and
        // before Whisper starts. Honour that request and remove the temp WAV.
        let cancelled_before_transcription = {
            let mut queue = queue_state
                .lock()
                .map_err(|error| format!("Queue lock error: {error}"))?;

            let cancelled = if let Some(job) = queue.jobs.iter_mut().find(|job| job.id == job_id) {
                if job.cancel_requested {
                    job.status = JobStatus::Cancelled;
                    job.progress = 0.0;
                    job.message = Some("Cancelled".to_string());
                    job.error = None;
                    true
                } else {
                    job.status = JobStatus::Transcribing;
                    job.progress = 0.0;
                    job.message = Some("Transcribing".to_string());
                    false
                }
            } else {
                true
            };

            emit_queue(&app, &queue);
            cancelled
        };

        if cancelled_before_transcription {
            let _ = std::fs::remove_file(&wav_path);
            continue;
        }

        // Every queued file gets the selected global transcription
        // settings, but its own input path.
        let mut job_settings = settings.clone();
        job_settings.input_file = source_path;

        // ----------------------------------------------------
        // Existing Whisper Desktop whisper.cpp pipeline
        // ----------------------------------------------------

        match crate::transcribe::run_transcription(
            app.clone(),
            logs.clone(),
            session.clone(),
            job_settings,
            wav_path,
            duration_sec,
        )
        .await
        {
            Ok(result) => {
                let mut queue = queue_state
                    .lock()
                    .map_err(|error| format!("Queue lock error: {error}"))?;

                if let Some(job) = queue.jobs.iter_mut().find(|job| job.id == job_id) {
                    job.status = JobStatus::Completed;
                    job.progress = 1.0;
                    job.message = Some(format!(
                        "Completed in {:.2}s",
                        result.duration_ms as f64 / 1000.0
                    ));
                    job.output_files = result.generated_files;
                    job.error = None;
                    job.duration_ms = Some(result.duration_ms);
                    job.speed_factor = Some(result.speed_factor);
                    job.cancel_requested = false;
                }

                emit_queue(&app, &queue);
            }

            Err(error) => {
                let mut queue = queue_state
                    .lock()
                    .map_err(|lock_error| format!("Queue lock error: {lock_error}"))?;

                if let Some(job) = queue.jobs.iter_mut().find(|job| job.id == job_id) {
                    if job.cancel_requested || looks_cancelled(&error) {
                        job.status = JobStatus::Cancelled;
                        job.progress = 0.0;
                        job.message = Some("Cancelled".to_string());
                        job.error = None;
                    } else {
                        job.status = JobStatus::Failed;
                        job.message = Some("Transcription failed".to_string());
                        job.error = Some(error);
                    }
                }

                // Again: failure does not terminate the queue.
                emit_queue(&app, &queue);
            }
        }
    }
}
