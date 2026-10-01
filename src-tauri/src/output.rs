use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
};

use tauri::AppHandle;

use crate::{logger::AppLogs, settings::WhisperSettings, SessionPhase, TranscriptionSession};

pub fn is_video_file(path: &str) -> bool {
    let extension = Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    crate::VIDEO_EXTENSIONS.contains(&extension.as_str())
}

pub fn prepare_job_settings(base: &WhisperSettings, source_path: &str) -> WhisperSettings {
    let mut settings = base.clone();
    settings.input_file = source_path.to_string();

    // Transcriber's V1 output policy:
    // - audio -> TXT
    // - video -> SRT internally, then embed that subtitle track in a new MKV
    if is_video_file(source_path) {
        settings.output_txt = false;
        settings.output_srt = true;

        // Subtitle-oriented segmentation.
        //
        // Whisper's default segmentation can keep a complete spoken sentence in
        // one long SRT cue. For video playback that feels unlike normal
        // subtitles: too much text remains on screen for too long.
        //
        // `max_len` is measured in characters by whisper.cpp. Combined with
        // `split_word`, this encourages short, word-boundary subtitle cues while
        // preserving Whisper's token timestamps. Around 32 characters normally
        // lands in the 4-7 word range for English and is short enough to avoid
        // the large two-line blocks we do not want as Transcriber's default.
        settings.max_len = 32;
        settings.split_word = true;
    } else {
        settings.output_txt = true;
        settings.output_srt = false;
    }

    settings.output_vtt = false;
    settings.output_lrc = false;
    settings.output_csv = false;
    settings.output_json = false;
    settings.output_json_full = false;

    settings
}

pub fn finalizing_message(source_path: &str) -> &'static str {
    if is_video_file(source_path) {
        "Embedding selectable subtitle track"
    } else {
        "Finalizing transcript"
    }
}

pub async fn finalize_transcription_outputs(
    app: AppHandle,
    logs: Arc<AppLogs>,
    session: Arc<Mutex<TranscriptionSession>>,
    source_path: &str,
    output_dir: &str,
    generated_files: &[String],
) -> Result<Vec<String>, String> {
    if is_video_file(source_path) {
        finalize_video(app, logs, session, source_path, output_dir, generated_files).await
    } else {
        finalize_audio(source_path, output_dir, generated_files)
    }
}

fn finalize_audio(
    source_path: &str,
    output_dir: &str,
    generated_files: &[String],
) -> Result<Vec<String>, String> {
    let output_dir = PathBuf::from(output_dir);

    let Some(txt_name) = generated_files
        .iter()
        .find(|file| file.to_ascii_lowercase().ends_with(".txt"))
    else {
        return Ok(generated_files.to_vec());
    };

    let source_txt = output_dir.join(txt_name);

    if !source_txt.is_file() {
        return Err(format!(
            "Expected transcript output was not found: {}",
            source_txt.display()
        ));
    }

    let source_stem = Path::new(source_path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();

    let desired = unique_path(&output_dir, &format!("{}_transcribed", source_stem), "txt");

    if source_txt != desired {
        std::fs::rename(&source_txt, &desired).map_err(|error| {
            format!(
                "Failed to rename transcript '{}' to '{}': {error}",
                source_txt.display(),
                desired.display()
            )
        })?;
    }

    Ok(vec![file_name_string(&desired)?])
}

async fn finalize_video(
    app: AppHandle,
    logs: Arc<AppLogs>,
    session: Arc<Mutex<TranscriptionSession>>,
    source_path: &str,
    output_dir: &str,
    generated_files: &[String],
) -> Result<Vec<String>, String> {
    let output_dir = PathBuf::from(output_dir);

    let Some(srt_name) = generated_files
        .iter()
        .find(|file| file.to_ascii_lowercase().ends_with(".srt"))
    else {
        return Err(
            "Video transcription completed, but no SRT subtitle file was generated.".to_string(),
        );
    };

    let srt_path = output_dir.join(srt_name);

    if !srt_path.is_file() {
        return Err(format!(
            "Generated subtitle file was not found: {}",
            srt_path.display()
        ));
    }

    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err(format!(
            "Source video no longer exists: {}",
            source.display()
        ));
    }

    let source_stem = source.file_stem().unwrap_or_default().to_string_lossy();

    // MKV is intentionally the default soft-subtitle container. It lets us
    // stream-copy the original video/audio/subtitle streams and add SRT without
    // re-encoding media or converting existing subtitle streams.
    let destination = unique_path(&output_dir, &format!("{} (Subbed)", source_stem), "mkv");

    let ffmpeg = crate::ffmpeg_resolver::ensure_ffmpeg_available(Some(&app))?;

    {
        let mut lock = session
            .lock()
            .map_err(|error| format!("Session lock error: {error}"))?;

        if lock.phase != SessionPhase::Idle {
            return Err("Another media task is already running.".to_string());
        }

        lock.phase = SessionPhase::Finalizing;
        lock.cancel_requested = false;
        lock.child_pid = None;
    }

    logs.log(
        &app,
        "Output",
        &format!(
            "Embedding subtitle track: '{}' -> '{}'",
            srt_path.display(),
            destination.display()
        ),
    );

    let mut command = tokio::process::Command::new(&ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("error")
        .arg("-i")
        .arg(&source)
        .arg("-i")
        .arg(&srt_path)
        .arg("-map")
        .arg("0")
        .arg("-map")
        .arg("1:0")
        .arg("-c")
        .arg("copy")
        .arg("-map_metadata")
        .arg("0")
        .arg(&destination)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }

    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            reset_session(&session);
            return Err(format!(
                "Failed to start FFmpeg subtitle embedding: {error}"
            ));
        }
    };

    let pid = child.id();

    {
        let mut lock = session
            .lock()
            .map_err(|error| format!("Session lock error: {error}"))?;
        lock.child_pid = pid;
    }

    let output = child.wait_with_output().await.map_err(|error| {
        reset_session(&session);
        format!("FFmpeg subtitle embedding failed to run: {error}")
    })?;

    let cancelled = {
        let lock = session
            .lock()
            .map_err(|error| format!("Session lock error: {error}"))?;
        lock.cancel_requested
    };

    reset_session(&session);

    if cancelled {
        let _ = std::fs::remove_file(&destination);
        return Err("Subtitle embedding was cancelled by the user.".to_string());
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();

        let _ = std::fs::remove_file(&destination);

        return Err(if detail.is_empty() {
            format!(
                "FFmpeg could not create the subtitled video (exit code {:?}).",
                output.status.code()
            )
        } else {
            format!("FFmpeg could not create the subtitled video: {detail}")
        });
    }

    // External SRT is an optional future Output setting. For the V1 default,
    // the generated SRT is an intermediate artifact and the new MKV is the
    // user-facing result.
    if let Err(error) = std::fs::remove_file(&srt_path) {
        logs.log(
            &app,
            "Output",
            &format!("Subtitled video was created, but temporary SRT cleanup failed: {error}"),
        );
    }

    logs.log(
        &app,
        "Output",
        &format!("Created subtitled video: {}", destination.display()),
    );

    Ok(vec![file_name_string(&destination)?])
}

fn reset_session(session: &Arc<Mutex<TranscriptionSession>>) {
    if let Ok(mut lock) = session.lock() {
        lock.child_pid = None;
        lock.phase = SessionPhase::Idle;
        lock.cancel_requested = false;
    }
}

fn unique_path(dir: &Path, stem: &str, extension: &str) -> PathBuf {
    let first = dir.join(format!("{stem}.{extension}"));
    if !first.exists() {
        return first;
    }

    for number in 2..10_000 {
        let candidate = dir.join(format!("{stem} ({number}).{extension}"));

        if !candidate.exists() {
            return candidate;
        }
    }

    dir.join(format!("{stem} ({}).{extension}", std::process::id()))
}

fn file_name_string(path: &Path) -> Result<String, String> {
    path.file_name()
        .map(|value| value.to_string_lossy().to_string())
        .ok_or_else(|| format!("Output path has no filename: {}", path.display()))
}
