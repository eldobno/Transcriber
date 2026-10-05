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
    // - normal audio -> TXT
    // - normal video -> full Whisper JSON -> custom movie subtitles -> soft-sub MKV
    // - Speaker Detection -> full Whisper JSON for word-level speaker assignment.
    if is_video_file(source_path) || settings.speaker_detection {
        settings.output_txt = false;
        settings.output_srt = false;
        settings.output_json = false;
        settings.output_json_full = true;

        // Word timestamps are required by both the movie subtitle engine and
        // WhisperX-style word-to-speaker assignment.
        settings.dtw_enabled = true;

        // whisper.cpp's current full-JSON + VAD path can expose compressed token
        // timestamps. Keep VAD disabled whenever we consume token timestamps.
        settings.vad = false;

        settings.max_len = 0;
        settings.split_word = false;
    } else {
        settings.output_txt = true;
        settings.output_srt = false;
        settings.output_json = false;
        settings.output_json_full = false;
    }

    settings.output_vtt = false;
    settings.output_lrc = false;
    settings.output_csv = false;

    settings
}

pub fn finalizing_message(source_path: &str) -> &'static str {
    if is_video_file(source_path) {
        "Building and embedding timed subtitles"
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
    speaker_segments: Option<&[crate::speaker_diarization::SpeakerSegment]>,
) -> Result<Vec<String>, String> {
    if is_video_file(source_path) {
        finalize_video(
            app,
            logs,
            session,
            source_path,
            output_dir,
            generated_files,
            speaker_segments,
        )
        .await
    } else {
        finalize_audio(
            source_path,
            output_dir,
            generated_files,
            speaker_segments,
        )
    }
}

fn finalize_audio(
    source_path: &str,
    output_dir: &str,
    generated_files: &[String],
    speaker_segments: Option<&[crate::speaker_diarization::SpeakerSegment]>,
) -> Result<Vec<String>, String> {
    let output_dir = PathBuf::from(output_dir);
    let source_stem = Path::new(source_path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let desired = unique_path(&output_dir, &format!("{}_transcribed", source_stem), "txt");

    if let Some(segments) = speaker_segments {
        let Some(json_name) = generated_files
            .iter()
            .find(|file| file.to_ascii_lowercase().ends_with(".json"))
        else {
            return Err(
                "Speaker Detection needs Whisper full JSON, but no timing JSON was generated."
                    .to_string(),
            );
        };

        let json_path = output_dir.join(json_name);
        let transcript = crate::speaker_diarization::build_speaker_transcript_from_whisper_json(
            &json_path,
            segments,
        )?;

        std::fs::write(&desired, transcript).map_err(|error| {
            format!(
                "Failed to write speaker-labelled transcript '{}': {error}",
                desired.display()
            )
        })?;

        // Full JSON is an implementation detail unless the user explicitly asks
        // for it in a future advanced output setting.
        let _ = std::fs::remove_file(json_path);
        return Ok(vec![desired.to_string_lossy().to_string()]);
    }

    let Some(txt_name) = generated_files
        .iter()
        .find(|file| file.to_ascii_lowercase().ends_with(".txt"))
    else {
        return Ok(generated_files
            .iter()
            .map(|file| output_dir.join(file).to_string_lossy().to_string())
            .collect());
    };

    let source_txt = output_dir.join(txt_name);

    if !source_txt.is_file() {
        return Err(format!(
            "Expected transcript output was not found: {}",
            source_txt.display()
        ));
    }

    if source_txt != desired {
        std::fs::rename(&source_txt, &desired).map_err(|error| {
            format!(
                "Failed to rename transcript '{}' to '{}': {error}",
                source_txt.display(),
                desired.display()
            )
        })?;
    }

    Ok(vec![desired.to_string_lossy().to_string()])
}

async fn finalize_video(
    app: AppHandle,
    logs: Arc<AppLogs>,
    session: Arc<Mutex<TranscriptionSession>>,
    source_path: &str,
    output_dir: &str,
    generated_files: &[String],
    speaker_segments: Option<&[crate::speaker_diarization::SpeakerSegment]>,
) -> Result<Vec<String>, String> {
    let output_dir = PathBuf::from(output_dir);

    let Some(json_name) = generated_files
        .iter()
        .find(|file| file.to_ascii_lowercase().ends_with(".json"))
    else {
        return Err(
            "Video transcription completed, but no full Whisper JSON timing file was generated."
                .to_string(),
        );
    };

    let json_path = output_dir.join(json_name);

    if !json_path.is_file() {
        return Err(format!(
            "Generated Whisper timing file was not found: {}",
            json_path.display()
        ));
    }

    let source_stem = Path::new(source_path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();

    let srt_path = unique_path(&output_dir, &format!("{} subtitles", source_stem), "srt");

    let timeline_offset_ms = probe_audio_timeline_offset_ms(&app, source_path)
        .await
        .unwrap_or(0);

    let cue_count =
        crate::subtitle::write_srt_from_whisper_json(&json_path, &srt_path, timeline_offset_ms)?;

    logs.log(
        &app,
        "Subtitles",
        &format!(
            "Built {cue_count} movie-style subtitle cues with media offset {timeline_offset_ms} ms"
        ),
    );

    let source = PathBuf::from(source_path);
    if !source.is_file() {
        return Err(format!(
            "Source video no longer exists: {}",
            source.display()
        ));
    }

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

    // Speaker Detection does not alter the movie subtitle track. For video we
    // additionally create a speaker-labelled TXT transcript after the MKV has
    // been built successfully. If this final speaker transcript step fails,
    // remove the MKV so the job remains atomic from the queue's perspective.
    let speaker_transcript_path = if let Some(segments) = speaker_segments {
        let path = unique_path(&output_dir, &format!("{}_transcribed", source_stem), "txt");
        let transcript = match crate::speaker_diarization::build_speaker_transcript_from_whisper_json(
            &json_path,
            segments,
        ) {
            Ok(transcript) => transcript,
            Err(error) => {
                let _ = std::fs::remove_file(&destination);
                let _ = std::fs::remove_file(&srt_path);
                return Err(error);
            }
        };

        if let Err(error) = std::fs::write(&path, transcript) {
            let _ = std::fs::remove_file(&destination);
            let _ = std::fs::remove_file(&srt_path);
            return Err(format!(
                "Failed to write speaker-labelled transcript '{}': {error}",
                path.display()
            ));
        }

        Some(path)
    } else {
        None
    };

    // External SRT is an optional future Output setting. For the V1 default,
    // the timing JSON and generated SRT are intermediate artifacts.
    for temporary in [&json_path, &srt_path] {
        if let Err(error) = std::fs::remove_file(temporary) {
            logs.log(
                &app,
                "Output",
                &format!(
                    "Subtitled video was created, but temporary file cleanup failed for '{}': {error}",
                    temporary.display()
                ),
            );
        }
    }

    logs.log(
        &app,
        "Output",
        &format!("Created subtitled video: {}", destination.display()),
    );

    let mut outputs = vec![destination.to_string_lossy().to_string()];
    if let Some(path) = speaker_transcript_path {
        outputs.push(path.to_string_lossy().to_string());
    }

    Ok(outputs)
}

async fn probe_audio_timeline_offset_ms(app: &AppHandle, source_path: &str) -> Result<i64, String> {
    let ffprobe = crate::ffmpeg_resolver::ensure_ffprobe_available(Some(app))?;

    let mut command = tokio::process::Command::new(ffprobe);

    command
        .arg("-v")
        .arg("error")
        .arg("-show_entries")
        .arg("stream=codec_type,start_time")
        .arg("-of")
        .arg("json")
        .arg(source_path)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped());

    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }

    let output = command
        .output()
        .await
        .map_err(|error| format!("Failed to inspect source media timestamps: {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "ffprobe could not inspect media timestamps: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let document: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Invalid ffprobe timestamp JSON: {error}"))?;

    let streams = document
        .get("streams")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "ffprobe returned no streams.".to_string())?;

    let mut earliest_start: Option<f64> = None;
    let mut audio_start: Option<f64> = None;

    for stream in streams {
        let Some(start) = stream
            .get("start_time")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| value.parse::<f64>().ok())
        else {
            continue;
        };

        earliest_start = Some(
            earliest_start
                .map(|current| current.min(start))
                .unwrap_or(start),
        );

        if audio_start.is_none()
            && stream.get("codec_type").and_then(serde_json::Value::as_str) == Some("audio")
        {
            audio_start = Some(start);
        }
    }

    let Some(audio_start) = audio_start else {
        return Ok(0);
    };

    let earliest_start = earliest_start.unwrap_or(audio_start);

    Ok(((audio_start - earliest_start) * 1000.0).round() as i64)
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

