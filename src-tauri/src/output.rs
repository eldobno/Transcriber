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

fn effective_output_selection(settings: &WhisperSettings, source_path: &str) -> (bool, bool, bool) {
    let is_video = is_video_file(source_path);
    let mut transcript = settings.output_transcript;
    let subtitle = settings.output_subtitle_file;
    let subtitled_video = is_video && settings.output_subtitled_video;

    // MKV is not meaningful for audio-only inputs. If a user has deliberately
    // selected only MKV and later drops audio, keep the zero-click workflow by
    // safely falling back to TXT for that audio file.
    if !is_video && !transcript && !subtitle {
        transcript = true;
    }

    // Sanitization already prevents a completely empty global selection, but
    // keep this local fallback so old/corrupt settings can never discard a job.
    if is_video && !transcript && !subtitle && !subtitled_video {
        transcript = true;
    }

    (transcript, subtitle, subtitled_video)
}

pub fn prepare_job_settings(base: &WhisperSettings, source_path: &str) -> WhisperSettings {
    let mut settings = base.clone();
    settings.input_file = source_path.to_string();

    let is_video = is_video_file(source_path);
    let (wants_transcript, wants_subtitle, wants_subtitled_video) =
        effective_output_selection(&settings, source_path);

    // Speaker Detection currently enriches TXT output. If TXT is not selected,
    // skip the diarization stage entirely instead of burning GPU time for data
    // that would never be surfaced to the user.
    settings.speaker_detection = settings.speaker_detection && wants_transcript;

    let needs_timing_json = (is_video && (wants_subtitle || wants_subtitled_video))
        || settings.speaker_detection;

    // whisper.cpp output flags are implementation details. The three user
    // choices above decide what survives finalization.
    settings.output_txt = wants_transcript && !settings.speaker_detection;
    settings.output_srt = wants_subtitle && !is_video;
    settings.output_vtt = false;
    settings.output_lrc = false;
    settings.output_csv = false;
    settings.output_json = false;
    settings.output_json_full = needs_timing_json;

    if needs_timing_json {
        // Word timestamps are required by the custom subtitle engine and by
        // WhisperX-style word-to-speaker assignment.
        settings.dtw_enabled = true;
        settings.vad = false;
        settings.max_len = 0;
        settings.split_word = false;
    }

    settings
}

pub fn finalizing_message(settings: &WhisperSettings, source_path: &str) -> &'static str {
    let (_, wants_subtitle, wants_subtitled_video) = effective_output_selection(settings, source_path);
    if wants_subtitled_video {
        "Building subtitled video"
    } else if wants_subtitle {
        "Creating subtitle file"
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
    settings: &WhisperSettings,
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
            settings,
        )
        .await
    } else {
        finalize_audio(
            source_path,
            output_dir,
            generated_files,
            speaker_segments,
            settings,
        )
    }
}

fn generated_path_by_extension(
    output_dir: &Path,
    generated_files: &[String],
    extension: &str,
) -> Option<PathBuf> {
    let suffix = format!(".{extension}");
    generated_files
        .iter()
        .find(|file| file.to_ascii_lowercase().ends_with(&suffix))
        .map(|file| output_dir.join(file))
}

fn rename_generated_output(source: &Path, destination: &Path, kind: &str) -> Result<(), String> {
    if !source.is_file() {
        return Err(format!("Expected {kind} output was not found: {}", source.display()));
    }

    if source != destination {
        std::fs::rename(source, destination).map_err(|error| {
            format!(
                "Failed to rename {kind} '{}' to '{}': {error}",
                source.display(),
                destination.display()
            )
        })?;
    }

    Ok(())
}

fn build_or_move_transcript(
    source_path: &str,
    output_dir: &Path,
    generated_files: &[String],
    speaker_segments: Option<&[crate::speaker_diarization::SpeakerSegment]>,
) -> Result<PathBuf, String> {
    let source_stem = Path::new(source_path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let desired = unique_path(output_dir, &format!("{}_transcribed", source_stem), "txt");

    if let Some(segments) = speaker_segments {
        let json_path = generated_path_by_extension(output_dir, generated_files, "json").ok_or_else(|| {
            "Speaker Detection needs Whisper full JSON, but no timing JSON was generated."
                .to_string()
        })?;
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
        return Ok(desired);
    }

    let source_txt = generated_path_by_extension(output_dir, generated_files, "txt")
        .ok_or_else(|| "Transcription completed, but no TXT output was generated.".to_string())?;
    rename_generated_output(&source_txt, &desired, "transcript")?;
    Ok(desired)
}

fn move_audio_subtitle(
    source_path: &str,
    output_dir: &Path,
    generated_files: &[String],
) -> Result<PathBuf, String> {
    let source_stem = Path::new(source_path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let desired = unique_path(output_dir, &format!("{} subtitles", source_stem), "srt");
    let source_srt = generated_path_by_extension(output_dir, generated_files, "srt")
        .ok_or_else(|| "Transcription completed, but no SRT output was generated.".to_string())?;
    rename_generated_output(&source_srt, &desired, "subtitle")?;
    Ok(desired)
}

fn cleanup_paths(paths: &[PathBuf]) {
    for path in paths {
        let _ = std::fs::remove_file(path);
    }
}

fn remove_internal_json(output_dir: &Path, generated_files: &[String]) {
    if let Some(json_path) = generated_path_by_extension(output_dir, generated_files, "json") {
        let _ = std::fs::remove_file(json_path);
    }
}

fn finalize_audio(
    source_path: &str,
    output_dir: &str,
    generated_files: &[String],
    speaker_segments: Option<&[crate::speaker_diarization::SpeakerSegment]>,
    settings: &WhisperSettings,
) -> Result<Vec<String>, String> {
    let output_dir = PathBuf::from(output_dir);
    let (wants_transcript, wants_subtitle, _) = effective_output_selection(settings, source_path);
    let mut outputs = Vec::new();
    let mut created = Vec::new();

    if wants_transcript {
        match build_or_move_transcript(source_path, &output_dir, generated_files, speaker_segments) {
            Ok(path) => {
                created.push(path.clone());
                outputs.push(path.to_string_lossy().to_string());
            }
            Err(error) => {
                cleanup_paths(&created);
                return Err(error);
            }
        }
    }

    if wants_subtitle {
        match move_audio_subtitle(source_path, &output_dir, generated_files) {
            Ok(path) => {
                created.push(path.clone());
                outputs.push(path.to_string_lossy().to_string());
            }
            Err(error) => {
                cleanup_paths(&created);
                return Err(error);
            }
        }
    }

    remove_internal_json(&output_dir, generated_files);

    if outputs.is_empty() {
        return Err("No compatible output format was selected for this audio file.".to_string());
    }

    Ok(outputs)
}

async fn finalize_video(
    app: AppHandle,
    logs: Arc<AppLogs>,
    session: Arc<Mutex<TranscriptionSession>>,
    source_path: &str,
    output_dir: &str,
    generated_files: &[String],
    speaker_segments: Option<&[crate::speaker_diarization::SpeakerSegment]>,
    settings: &WhisperSettings,
) -> Result<Vec<String>, String> {
    let output_dir = PathBuf::from(output_dir);
    let (wants_transcript, wants_subtitle, wants_subtitled_video) =
        effective_output_selection(settings, source_path);
    let source_stem = Path::new(source_path)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();

    let mut outputs = Vec::new();
    let mut created = Vec::<PathBuf>::new();

    if wants_transcript {
        match build_or_move_transcript(source_path, &output_dir, generated_files, speaker_segments) {
            Ok(path) => {
                created.push(path.clone());
                outputs.push(path.to_string_lossy().to_string());
            }
            Err(error) => {
                cleanup_paths(&created);
                return Err(error);
            }
        }
    }

    let mut subtitle_path: Option<PathBuf> = None;
    if wants_subtitle || wants_subtitled_video {
        let Some(json_path) = generated_path_by_extension(&output_dir, generated_files, "json") else {
            cleanup_paths(&created);
            return Err(
                "Video transcription completed, but no full Whisper JSON timing file was generated."
                    .to_string(),
            );
        };

        if !json_path.is_file() {
            cleanup_paths(&created);
            return Err(format!(
                "Generated Whisper timing file was not found: {}",
                json_path.display()
            ));
        }

        let srt_path = unique_path(&output_dir, &format!("{} subtitles", source_stem), "srt");
        let timeline_offset_ms = probe_audio_timeline_offset_ms(&app, source_path)
            .await
            .unwrap_or(0);

        let cue_count = match crate::subtitle::write_srt_from_whisper_json(
            &json_path,
            &srt_path,
            timeline_offset_ms,
        ) {
            Ok(count) => count,
            Err(error) => {
                cleanup_paths(&created);
                return Err(error);
            }
        };

        logs.log(
            &app,
            "Subtitles",
            &format!(
                "Built {cue_count} movie-style subtitle cues with media offset {timeline_offset_ms} ms"
            ),
        );

        created.push(srt_path.clone());
        subtitle_path = Some(srt_path.clone());

        if wants_subtitle {
            outputs.push(srt_path.to_string_lossy().to_string());
        }
    }

    if wants_subtitled_video {
        let Some(srt_path) = subtitle_path.as_ref() else {
            cleanup_paths(&created);
            return Err("Subtitle preparation did not produce an SRT track.".to_string());
        };

        let source = PathBuf::from(source_path);
        if !source.is_file() {
            cleanup_paths(&created);
            return Err(format!("Source video no longer exists: {}", source.display()));
        }

        let destination = unique_path(&output_dir, &format!("{} (Subbed)", source_stem), "mkv");
        if let Err(error) = embed_subtitle_track(
            &app,
            &logs,
            &session,
            &source,
            srt_path,
            &destination,
        )
        .await
        {
            cleanup_paths(&created);
            return Err(error);
        }

        created.push(destination.clone());
        outputs.push(destination.to_string_lossy().to_string());
        logs.log(
            &app,
            "Output",
            &format!("Created subtitled video: {}", destination.display()),
        );
    }

    // SRT is a temporary muxing artifact when the user did not explicitly ask
    // to keep it as a standalone output.
    if !wants_subtitle {
        if let Some(path) = subtitle_path.as_ref() {
            let _ = std::fs::remove_file(path);
            created.retain(|created_path| created_path != path);
        }
    }

    remove_internal_json(&output_dir, generated_files);

    if outputs.is_empty() {
        cleanup_paths(&created);
        return Err("No output format was selected for this video.".to_string());
    }

    Ok(outputs)
}

async fn embed_subtitle_track(
    app: &AppHandle,
    logs: &Arc<AppLogs>,
    session: &Arc<Mutex<TranscriptionSession>>,
    source: &Path,
    srt_path: &Path,
    destination: &Path,
) -> Result<(), String> {
    let ffmpeg = crate::ffmpeg_resolver::ensure_ffmpeg_available(Some(app))?;

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
        app,
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
        .arg(source)
        .arg("-i")
        .arg(srt_path)
        .arg("-map")
        .arg("0")
        .arg("-map")
        .arg("1:0")
        .arg("-c")
        .arg("copy")
        .arg("-map_metadata")
        .arg("0")
        .arg(destination)
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
            reset_session(session);
            return Err(format!("Failed to start FFmpeg subtitle embedding: {error}"));
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
        reset_session(session);
        format!("FFmpeg subtitle embedding failed to run: {error}")
    })?;

    let cancelled = {
        let lock = session
            .lock()
            .map_err(|error| format!("Session lock error: {error}"))?;
        lock.cancel_requested
    };

    reset_session(session);

    if cancelled {
        let _ = std::fs::remove_file(destination);
        return Err("Subtitle embedding was cancelled by the user.".to_string());
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        let _ = std::fs::remove_file(destination);
        return Err(if detail.is_empty() {
            format!(
                "FFmpeg could not create the subtitled video (exit code {:?}).",
                output.status.code()
            )
        } else {
            format!("FFmpeg could not create the subtitled video: {detail}")
        });
    }

    Ok(())
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
