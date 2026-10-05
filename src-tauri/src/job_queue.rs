use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_notification::NotificationExt;

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
    Finalizing,
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
    pub conversion_ms: Option<u64>,
    pub diarization_ms: Option<u64>,
    pub speaker_count: Option<usize>,
    pub speaker_backend: Option<String>,
    pub transcription_ms: Option<u64>,
    pub finalization_ms: Option<u64>,
    pub created_at_ms: u64,
    pub started_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,

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
    pub already_processed_paths: Vec<String>,
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

/// Transcriber creates soft-subtitled video outputs as MKV files with the
/// "(Subbed)" marker in the filename. Treat those files as generated outputs
/// rather than fresh source media. This intentionally catches renamed/copy
/// variants too, e.g. "Movie (Subbed) - Copy.mkv" and
/// "Movie (Subbed) (2).mkv", so recursively adding a folder cannot feed
/// Transcriber's own outputs back into the queue.
fn is_transcriber_generated_video_output(path: &str) -> bool {
    let path = Path::new(path);

    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default();

    if !extension.eq_ignore_ascii_case("mkv") {
        return false;
    }

    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| stem.to_lowercase().contains("(subbed)"))
        .unwrap_or(false)
}

fn collect_input_path(
    path: &Path,
    media_paths: &mut Vec<String>,
    ignored_paths: &mut Vec<String>,
    visited_directories: &mut HashSet<String>,
) {
    if path.is_dir() {
        let directory_key = std::fs::canonicalize(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .to_string_lossy()
            .to_string();

        #[cfg(target_os = "windows")]
        let directory_key = directory_key.to_lowercase();

        if !visited_directories.insert(directory_key) {
            return;
        }

        let mut entries = match std::fs::read_dir(path) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .collect::<Vec<_>>(),
            Err(_) => {
                ignored_paths.push(path.to_string_lossy().to_string());
                return;
            }
        };

        // Stable, human-friendly ordering for recursively-added folders.
        entries.sort_by(|left, right| {
            left.to_string_lossy()
                .to_lowercase()
                .cmp(&right.to_string_lossy().to_lowercase())
        });

        for entry in entries {
            collect_input_path(&entry, media_paths, ignored_paths, visited_directories);
        }

        return;
    }

    if path.is_file() {
        let value = path.to_string_lossy().to_string();

        if is_supported_media(&value) {
            media_paths.push(value);
        } else {
            ignored_paths.push(value);
        }

        return;
    }

    ignored_paths.push(path.to_string_lossy().to_string());
}

fn expand_input_paths(paths: Vec<String>) -> (Vec<String>, Vec<String>) {
    let mut media_paths = Vec::new();
    let mut ignored_paths = Vec::new();
    let mut visited_directories = HashSet::new();

    for raw_path in paths {
        collect_input_path(
            Path::new(&raw_path),
            &mut media_paths,
            &mut ignored_paths,
            &mut visited_directories,
        );
    }

    (media_paths, ignored_paths)
}

fn file_modified_ms(path: &Path) -> Option<u64> {
    path.metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn resolve_history_output_path(
    output: &str,
    source_path: &str,
    settings: &crate::settings::WhisperSettings,
) -> PathBuf {
    let output_path = PathBuf::from(output);
    if output_path.is_absolute() {
        return output_path;
    }

    let source = Path::new(source_path);
    let source_parent = source.parent().unwrap_or_else(|| Path::new("."));
    crate::transcribe::resolve_output_dir(settings, source_parent).join(output_path)
}

fn completed_history_dedup_index(
    history: &crate::history::HistoryState,
) -> (HashSet<String>, HashSet<String>) {
    let settings = crate::settings::load_settings_file();
    let entries = history.entries(10_000, 0).unwrap_or_default();
    let mut processed_sources = HashSet::new();
    let mut known_outputs = HashSet::new();

    for entry in entries.into_iter().filter(|entry| entry.status == "completed") {
        let existing_outputs = entry
            .output_files
            .iter()
            .map(|output| resolve_history_output_path(output, &entry.source_path, &settings))
            .filter(|path| path.is_file())
            .collect::<Vec<_>>();

        if existing_outputs.is_empty() {
            continue;
        }

        for output in existing_outputs {
            known_outputs.insert(path_key(&output.to_string_lossy()));
        }

        // Skip the source only while it still looks like the exact file that was
        // completed. If it has been modified since then, allow it through so the
        // user can intentionally re-transcribe the newer media.
        if let (Some(completed_at_ms), Some(modified_at_ms)) = (
            entry.completed_at_ms,
            file_modified_ms(Path::new(&entry.source_path)),
        ) {
            if modified_at_ms <= completed_at_ms.saturating_add(2_000) {
                processed_sources.insert(path_key(&entry.source_path));
            }
        }
    }

    (processed_sources, known_outputs)
}

fn history_context(
    job: &QueueJob,
    settings: &crate::settings::WhisperSettings,
) -> crate::history::HistoryJobContext {
    crate::history::HistoryJobContext {
        id: job.id.clone(),
        source_path: job.source_path.clone(),
        file_name: job.file_name.clone(),
        media_duration_sec: job.duration_sec,
        model: settings.model_path.clone(),
        backend: settings.selected_backend.clone(),
        created_at_ms: job.created_at_ms,
        started_at_ms: job.started_at_ms,
    }
}

fn processing_duration_ms(job: &QueueJob) -> Option<u64> {
    match (job.started_at_ms, job.completed_at_ms) {
        (Some(started), Some(completed)) if completed >= started => Some(completed - started),
        _ => None,
    }
}

fn record_history_finished(
    app: &AppHandle,
    logs: &Arc<crate::logger::AppLogs>,
    history: &crate::history::HistoryState,
    job: &QueueJob,
    settings: &crate::settings::WhisperSettings,
) {
    let finish = crate::history::HistoryFinish {
        status: match job.status {
            JobStatus::Completed => "completed",
            JobStatus::Failed => "failed",
            JobStatus::Cancelled => "cancelled",
            _ => return,
        }
        .to_string(),
        completed_at_ms: job.completed_at_ms.unwrap_or_else(now_ms),
        processing_duration_ms: processing_duration_ms(job),
        speed_factor: job.speed_factor,
        output_files: job.output_files.clone(),
        error: job.error.clone(),
    };

    if let Err(error) = history.record_finished(&history_context(job, settings), &finish) {
        logs.log(app, "History", &error);
    }
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
    history_state: State<'_, crate::history::HistoryState>,
    paths: Vec<String>,
) -> Result<AddJobsResult, String> {
    let (paths, ignored_paths) = expand_input_paths(paths);
    let (processed_sources, known_outputs) = completed_history_dedup_index(&history_state);
    let mut already_processed_paths = Vec::new();

    for path in paths {
        let key = path_key(&path);

        // First reject our own generated video outputs by their stable naming
        // marker. History/path matching alone is not enough because Windows can
        // rename copies (" - Copy", "(2)", etc.), producing a different path
        // that still points to a Transcriber-generated subtitled video.
        if is_transcriber_generated_video_output(&path)
            || processed_sources.contains(&key)
            || known_outputs.contains(&key)
        {
            already_processed_paths.push(path);
            continue;
        }

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
                conversion_ms: None,
                diarization_ms: None,
                speaker_count: None,
                speaker_backend: None,
                transcription_ms: None,
                finalization_ms: None,
                created_at_ms: now_ms(),
                started_at_ms: None,
                completed_at_ms: None,
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
        already_processed_paths,
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

    if matches!(
        status,
        JobStatus::Converting | JobStatus::Transcribing | JobStatus::Finalizing
    ) {
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
        JobStatus::Converting | JobStatus::Transcribing | JobStatus::Finalizing
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

    queue.jobs.retain(|job| {
        matches!(
            job.status,
            JobStatus::Converting | JobStatus::Transcribing | JobStatus::Finalizing
        )
    });

    emit_queue(&app, &queue);

    Ok(snapshot(&queue))
}

#[tauri::command]
pub async fn cancel_queue_job(
    app: AppHandle,
    state: State<'_, JobQueueState>,
    session_state: State<'_, crate::TranscriptionState>,
    log_state: State<'_, crate::LogState>,
    history_state: State<'_, crate::history::HistoryState>,
    job_id: String,
) -> Result<JobQueueSnapshot, String> {
    let (should_cancel_session, terminal_job) = {
        let mut queue = state
            .0
            .lock()
            .map_err(|error| format!("Queue lock error: {error}"))?;

        let job = queue
            .jobs
            .iter_mut()
            .find(|job| job.id == job_id)
            .ok_or_else(|| "Queue job not found.".to_string())?;

        let active = matches!(
            job.status,
            JobStatus::Converting | JobStatus::Transcribing | JobStatus::Finalizing
        );

        let mut terminal_job = None;

        match job.status {
            JobStatus::Inspecting | JobStatus::Ready | JobStatus::Queued => {
                job.cancel_requested = true;
                job.status = JobStatus::Cancelled;
                job.progress = 0.0;
                job.message = Some("Cancelled".to_string());
                job.error = None;
                job.completed_at_ms = Some(now_ms());
                terminal_job = Some(job.clone());
            }

            JobStatus::Converting | JobStatus::Transcribing | JobStatus::Finalizing => {
                job.cancel_requested = true;
                job.message = Some("Cancelling...".to_string());
            }

            JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled => {
                return Ok(snapshot(&queue));
            }
        }

        emit_queue(&app, &queue);
        (active, terminal_job)
    };

    if let Some(job) = terminal_job {
        let settings = crate::settings::load_settings_file();
        record_history_finished(&app, &log_state.0, &history_state, &job, &settings);
    }

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


#[tauri::command]
pub async fn cancel_job_queue(
    app: AppHandle,
    state: State<'_, JobQueueState>,
    session_state: State<'_, crate::TranscriptionState>,
    log_state: State<'_, crate::LogState>,
    history_state: State<'_, crate::history::HistoryState>,
) -> Result<JobQueueSnapshot, String> {
    let (should_cancel_session, terminal_jobs) = {
        let mut queue = state
            .0
            .lock()
            .map_err(|error| format!("Queue lock error: {error}"))?;

        let mut should_cancel_session = false;
        let mut terminal_jobs = Vec::new();

        for job in &mut queue.jobs {
            match job.status {
                JobStatus::Inspecting | JobStatus::Ready | JobStatus::Queued => {
                    if !job.cancel_requested {
                        job.cancel_requested = true;
                        job.status = JobStatus::Cancelled;
                        job.progress = 0.0;
                        job.message = Some("Cancelled".to_string());
                        job.error = None;
                        job.completed_at_ms = Some(now_ms());
                        terminal_jobs.push(job.clone());
                    }
                }
                JobStatus::Converting | JobStatus::Transcribing | JobStatus::Finalizing => {
                    job.cancel_requested = true;
                    job.message = Some("Cancelling...".to_string());
                    should_cancel_session = true;
                }
                JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled => {}
            }
        }

        emit_queue(&app, &queue);
        (should_cancel_session, terminal_jobs)
    };

    if !terminal_jobs.is_empty() {
        let settings = crate::settings::load_settings_file();
        for job in &terminal_jobs {
            record_history_finished(&app, &log_state.0, &history_state, job, &settings);
        }
    }

    if should_cancel_session {
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
    history_state: State<'_, crate::history::HistoryState>,
    settings: crate::settings::WhisperSettings,
) -> Result<JobQueueSnapshot, String> {
    let queue_state = state.0.clone();
    let logs = log_state.0.clone();
    let session = session_state.0.clone();
    let queue_run_started_ms = now_ms();

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

    let _sleep_inhibitor = match crate::power::SleepInhibitor::acquire() {
        Ok(guard) => Some(guard),
        Err(error) => {
            logs.log(&app, "Queue", &format!("Could not prevent system sleep: {error}"));
            None
        }
    };

    let final_snapshot = loop {
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
                break snapshot(&queue);
            };

            let job = &mut queue.jobs[index];

            job.status = JobStatus::Converting;
            job.progress = 0.0;
            job.message = Some("Converting media".to_string());
            job.error = None;
            job.started_at_ms = Some(now_ms());
            job.completed_at_ms = None;
            job.duration_ms = None;
            job.speed_factor = None;
            job.conversion_ms = None;
            job.diarization_ms = None;
            job.speaker_count = None;
            job.speaker_backend = None;
            job.transcription_ms = None;
            job.finalization_ms = None;

            let data = (
                job.id.clone(),
                job.source_path.clone(),
                job.duration_sec,
                job.clone(),
            );

            emit_queue(&app, &queue);

            data
        };

        let (job_id, source_path, duration_sec, started_job) = next_job;

        let job_settings = crate::output::prepare_job_settings(&settings, &source_path);

        if let Err(error) =
            history_state.record_started(&history_context(&started_job, &job_settings))
        {
            logs.log(&app, "History", &error);
        }

        // ----------------------------------------------------
        // Existing FFmpeg conversion pipeline
        // ----------------------------------------------------

        let conversion_started = Instant::now();
        let conversion_result = crate::transcribe::convert_to_wav(
            app.clone(),
            logs.clone(),
            session.clone(),
            source_path.clone(),
        )
        .await;
        let conversion_ms = conversion_started.elapsed().as_millis() as u64;
        {
            let mut queue = queue_state
                .lock()
                .map_err(|error| format!("Queue lock error: {error}"))?;
            if let Some(job) = queue.jobs.iter_mut().find(|job| job.id == job_id) {
                job.conversion_ms = Some(conversion_ms);
            }
        }

        let wav_path = match conversion_result {
            Ok(path) => path,

            Err(error) => {
                let mut queue = queue_state
                    .lock()
                    .map_err(|lock_error| format!("Queue lock error: {lock_error}"))?;

                let mut terminal_job = None;

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

                    job.completed_at_ms = Some(now_ms());
                    terminal_job = Some(job.clone());
                }

                // A failed file must NOT stop the rest of the queue.
                emit_queue(&app, &queue);

                if let Some(job) = terminal_job {
                    record_history_finished(&app, &logs, &history_state, &job, &job_settings);
                }

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
                    job.completed_at_ms = Some(now_ms());
                    true
                } else {
                    job.status = JobStatus::Transcribing;
                    job.progress = 0.0;
                    job.message = Some(if job_settings.speaker_detection {
                        "Detecting speakers".to_string()
                    } else {
                        "Transcribing".to_string()
                    });
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

            let queue = queue_state
                .lock()
                .map_err(|error| format!("Queue lock error: {error}"))?;

            if let Some(job) = queue.jobs.iter().find(|job| job.id == job_id) {
                record_history_finished(&app, &logs, &history_state, job, &job_settings);
            }

            continue;
        }

        // Every queued file uses Transcriber's output policy while
        // preserving the selected model/backend and transcription options.

        // ----------------------------------------------------
        // Optional Speaker Detection
        // ----------------------------------------------------
        // Reuse the exact 16 kHz mono WAV that Whisper is about to consume.
        // This keeps diarization and Whisper word timestamps on the same audio
        // timeline and avoids a second decode/resample pass.
        let speaker_segments = if job_settings.speaker_detection {
            let diarization_started = Instant::now();
            let diarization_result = crate::speaker_diarization::run_speaker_diarization(
                app.clone(),
                logs.clone(),
                session.clone(),
                &wav_path,
                &job_settings,
            )
            .await;
            let diarization_ms = diarization_started.elapsed().as_millis() as u64;
            {
                let mut queue = queue_state
                    .lock()
                    .map_err(|error| format!("Queue lock error: {error}"))?;
                if let Some(job) = queue.jobs.iter_mut().find(|job| job.id == job_id) {
                    job.diarization_ms = Some(diarization_ms);
                }
            }

            match diarization_result {
                Ok(segments) => {
                    let speaker_count = segments
                        .iter()
                        .map(|segment| segment.speaker)
                        .max()
                        .map(|speaker| speaker + 1)
                        .unwrap_or(0);
                    let speaker_backend =
                        crate::speaker_diarization::current_speaker_backend(&job_settings);

                    let mut queue = queue_state
                        .lock()
                        .map_err(|error| format!("Queue lock error: {error}"))?;
                    if let Some(job) = queue.jobs.iter_mut().find(|job| job.id == job_id) {
                        job.speaker_count = Some(speaker_count);
                        job.speaker_backend = Some(speaker_backend);
                        job.message = Some(format!(
                            "{speaker_count} speaker{} detected",
                            if speaker_count == 1 { "" } else { "s" }
                        ));
                    }
                    emit_queue(&app, &queue);
                    drop(queue);

                    Some(segments)
                }
                Err(error) => {
                    // Whisper normally owns temporary WAV cleanup. If speaker
                    // detection fails before Whisper starts, clean it here.
                    let _ = std::fs::remove_file(&wav_path);

                    let mut queue = queue_state
                        .lock()
                        .map_err(|lock_error| format!("Queue lock error: {lock_error}"))?;

                    let mut terminal_job = None;
                    if let Some(job) = queue.jobs.iter_mut().find(|job| job.id == job_id) {
                        if job.cancel_requested || looks_cancelled(&error) {
                            job.status = JobStatus::Cancelled;
                            job.progress = 0.0;
                            job.message = Some("Cancelled".to_string());
                            job.error = None;
                        } else {
                            job.status = JobStatus::Failed;
                            job.progress = 0.0;
                            job.message = Some("Speaker Detection failed".to_string());
                            job.error = Some(error);
                        }
                        job.completed_at_ms = Some(now_ms());
                        terminal_job = Some(job.clone());
                    }

                    emit_queue(&app, &queue);
                    if let Some(job) = terminal_job {
                        record_history_finished(&app, &logs, &history_state, &job, &job_settings);
                    }

                    // A diarization failure affects only this file, never the
                    // rest of the sequential queue.
                    continue;
                }
            }
        } else {
            None
        };

        // Cancellation can also land between the diarization child exiting and
        // Whisper starting. Honour it before launching the expensive model.
        let cancelled_before_whisper = {
            let mut queue = queue_state
                .lock()
                .map_err(|error| format!("Queue lock error: {error}"))?;

            let cancelled = if let Some(job) = queue.jobs.iter_mut().find(|job| job.id == job_id) {
                if job.cancel_requested {
                    job.status = JobStatus::Cancelled;
                    job.progress = 0.0;
                    job.message = Some("Cancelled".to_string());
                    job.error = None;
                    job.completed_at_ms = Some(now_ms());
                    true
                } else {
                    job.status = JobStatus::Transcribing;
                    job.progress = 0.0;
                    job.message = Some(match job.speaker_count {
                        Some(count) if count > 0 => format!(
                            "{count} speaker{} · Transcribing",
                            if count == 1 { "" } else { "s" }
                        ),
                        _ => "Transcribing".to_string(),
                    });
                    false
                }
            } else {
                true
            };

            emit_queue(&app, &queue);
            cancelled
        };

        if cancelled_before_whisper {
            let _ = std::fs::remove_file(&wav_path);

            let queue = queue_state
                .lock()
                .map_err(|error| format!("Queue lock error: {error}"))?;
            if let Some(job) = queue.jobs.iter().find(|job| job.id == job_id) {
                record_history_finished(&app, &logs, &history_state, job, &job_settings);
            }
            continue;
        }

        // ----------------------------------------------------
        // Existing whisper.cpp transcription pipeline
        // ----------------------------------------------------

        let transcription_started = Instant::now();
        let transcription_result = crate::transcribe::run_transcription(
            app.clone(),
            logs.clone(),
            session.clone(),
            job_settings.clone(),
            wav_path,
            duration_sec,
            false,
        )
        .await;
        let transcription_ms = transcription_started.elapsed().as_millis() as u64;
        {
            let mut queue = queue_state
                .lock()
                .map_err(|error| format!("Queue lock error: {error}"))?;
            if let Some(job) = queue.jobs.iter_mut().find(|job| job.id == job_id) {
                job.transcription_ms = Some(transcription_ms);
            }
        }

        match transcription_result {
            Ok(result) => {
                {
                    let mut queue = queue_state
                        .lock()
                        .map_err(|error| format!("Queue lock error: {error}"))?;

                    if let Some(job) = queue.jobs.iter_mut().find(|job| job.id == job_id) {
                        job.status = JobStatus::Finalizing;
                        job.progress = 1.0;
                        job.message =
                            Some(crate::output::finalizing_message(&source_path).to_string());
                        job.error = None;
                    }

                    emit_queue(&app, &queue);
                }

                let finalization_started = Instant::now();
                let final_outputs = crate::output::finalize_transcription_outputs(
                    app.clone(),
                    logs.clone(),
                    session.clone(),
                    &source_path,
                    &result.output_dir,
                    &result.generated_files,
                    speaker_segments.as_deref(),
                )
                .await;
                let finalization_ms = finalization_started.elapsed().as_millis() as u64;

                let mut queue = queue_state
                    .lock()
                    .map_err(|error| format!("Queue lock error: {error}"))?;

                if let Some(job) = queue.jobs.iter_mut().find(|job| job.id == job_id) {
                    job.finalization_ms = Some(finalization_ms);
                    match final_outputs {
                        Ok(output_files) => {
                            job.status = JobStatus::Completed;
                            job.progress = 1.0;
                            job.output_files = output_files;
                            job.error = None;
                            job.cancel_requested = false;
                        }

                        Err(error) => {
                            if job.cancel_requested || looks_cancelled(&error) {
                                job.status = JobStatus::Cancelled;
                                job.progress = 0.0;
                                job.message = Some("Cancelled".to_string());
                                job.error = None;
                            } else {
                                job.status = JobStatus::Failed;
                                job.message = Some("Output finalization failed".to_string());
                                job.error = Some(error);
                            }
                        }
                    }

                    job.completed_at_ms = Some(now_ms());
                    if job.status == JobStatus::Completed {
                        if let Some(total_ms) = processing_duration_ms(job) {
                            job.duration_ms = Some(total_ms);
                            job.speed_factor = if total_ms > 0 && job.duration_sec > 0.0 {
                                Some((job.duration_sec * 1000.0) / total_ms as f64)
                            } else {
                                None
                            };
                            job.message = None;
                        }
                    }
                }

                emit_queue(&app, &queue);

                if let Some(job) = queue.jobs.iter().find(|job| job.id == job_id) {
                    record_history_finished(&app, &logs, &history_state, job, &job_settings);
                }
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

                    job.completed_at_ms = Some(now_ms());
                }

                // Again: failure does not terminate the queue.
                emit_queue(&app, &queue);

                if let Some(job) = queue.jobs.iter().find(|job| job.id == job_id) {
                    record_history_finished(&app, &logs, &history_state, job, &job_settings);
                }
            }
        }
    };

    let completed = final_snapshot
        .jobs
        .iter()
        .filter(|job| {
            job.status == JobStatus::Completed
                && job.started_at_ms.is_some_and(|started| started >= queue_run_started_ms)
        })
        .count();
    let failed = final_snapshot
        .jobs
        .iter()
        .filter(|job| {
            job.status == JobStatus::Failed
                && job.started_at_ms.is_some_and(|started| started >= queue_run_started_ms)
        })
        .count();
    let cancelled = final_snapshot
        .jobs
        .iter()
        .filter(|job| {
            job.status == JobStatus::Cancelled
                && job.started_at_ms.is_some_and(|started| started >= queue_run_started_ms)
        })
        .count();

    let body = if failed == 0 && cancelled == 0 {
        format!("Finished {completed} file{}.", if completed == 1 { "" } else { "s" })
    } else {
        format!("{completed} completed • {failed} failed • {cancelled} cancelled")
    };

    let _ = app
        .notification()
        .builder()
        .title("Transcriber queue finished")
        .body(&body)
        .show();
    logs.log(&app, "Queue", &format!("Queue finished: {body}"));

    Ok(final_snapshot)
}

#[cfg(test)]
mod generated_output_dedup_tests {
    use super::is_transcriber_generated_video_output;

    #[test]
    fn recognizes_transcriber_subbed_mkv_variants() {
        assert!(is_transcriber_generated_video_output(
            r"C:\Media\Movie (Subbed).mkv"
        ));
        assert!(is_transcriber_generated_video_output(
            r"C:\Media\Movie (Subbed) (2) - Copy.mkv"
        ));
        assert!(is_transcriber_generated_video_output(
            r"C:\Media\Movie (SUBBED) (Subbed) - Copy.MKV"
        ));
    }

    #[test]
    fn does_not_flag_normal_media_or_non_mkv_files() {
        assert!(!is_transcriber_generated_video_output(
            r"C:\Media\Movie.mkv"
        ));
        assert!(!is_transcriber_generated_video_output(
            r"C:\Media\Movie (Subbed).mp4"
        ));
        assert!(!is_transcriber_generated_video_output(
            r"C:\Media\meeting.wav"
        ));
    }
}
