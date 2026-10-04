use serde::Serialize;
use serde_json::Value;
use speakrs::{ExecutionMode, ModelManager, OwnedDiarizationPipeline, Segment};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::{AppHandle, Emitter};

use crate::{logger::AppLogs, transcribe::TranscribeProgress};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerSegment {
    pub start_sec: f64,
    pub end_sec: f64,
    pub speaker: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerDetectionStatus {
    pub available: bool,
    pub runtime_found: bool,
    pub segmentation_model_found: bool,
    pub embedding_model_found: bool,
    pub missing: Vec<String>,
}

struct SessionResetGuard {
    session: Arc<Mutex<crate::TranscriptionSession>>,
}

impl Drop for SessionResetGuard {
    fn drop(&mut self) {
        if let Ok(mut lock) = self.session.lock() {
            lock.child_pid = None;
            lock.phase = crate::SessionPhase::Idle;
            lock.cancel_requested = false;
        }
    }
}

fn speakrs_cache_dir(models_dir: &str) -> PathBuf {
    Path::new(models_dir)
        .join("speaker-diarization")
        .join("speakrs")
}

fn cache_has_files(path: &Path) -> bool {
    let Ok(mut entries) = std::fs::read_dir(path) else {
        return false;
    };

    entries.next().is_some()
}

/// `speakrs` is linked into Transcriber, so there is no separate runtime EXE.
/// Models are downloaded by speakrs only when the user explicitly enables and
/// starts Speaker Detection, then cached under Transcriber's models directory.
pub fn speaker_detection_status(
    _app: &AppHandle,
    models_dir: &str,
) -> SpeakerDetectionStatus {
    let cache_dir = speakrs_cache_dir(models_dir);
    let model_cache_present = cache_has_files(&cache_dir);

    SpeakerDetectionStatus {
        // Do not block Start Queue merely because the models have not been
        // downloaded yet; ModelManager provisions them on first explicit use.
        available: true,
        runtime_found: true,
        segmentation_model_found: model_cache_present,
        embedding_model_found: model_cache_present,
        missing: if model_cache_present {
            Vec::new()
        } else {
            vec!["speakrs model bundle (downloads on first Speaker Detection run)".to_string()]
        },
    }
}

#[tauri::command]
pub fn get_speaker_detection_status(
    app: AppHandle,
    models_dir: String,
) -> SpeakerDetectionStatus {
    speaker_detection_status(&app, &models_dir)
}

fn execution_mode(settings: &crate::settings::WhisperSettings) -> ExecutionMode {
    if settings.selected_backend.eq_ignore_ascii_case("CUDA") {
        // 1-second segmentation step: prefer boundary accuracy over CudaFast.
        ExecutionMode::Cuda
    } else {
        ExecutionMode::Cpu
    }
}

fn read_pcm16_mono_16khz(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path).map_err(|error| {
        format!(
            "Failed to open Speaker Detection WAV '{}': {error}",
            path.display()
        )
    })?;

    let spec = reader.spec();

    if spec.sample_rate != 16_000 {
        return Err(format!(
            "Speaker Detection expected 16 kHz audio, but received {} Hz.",
            spec.sample_rate
        ));
    }

    if spec.channels != 1 {
        return Err(format!(
            "Speaker Detection expected mono audio, but received {} channels.",
            spec.channels
        ));
    }

    if spec.sample_format != hound::SampleFormat::Int || spec.bits_per_sample != 16 {
        return Err(format!(
            "Speaker Detection expected PCM 16-bit WAV, but received {:?}/{}-bit.",
            spec.sample_format, spec.bits_per_sample
        ));
    }

    let mut samples = Vec::with_capacity(reader.len() as usize);

    for sample in reader.samples::<i16>() {
        let sample = sample.map_err(|error| {
            format!(
                "Failed reading Speaker Detection WAV '{}': {error}",
                path.display()
            )
        })?;
        samples.push(sample as f32 / 32768.0);
    }

    if samples.is_empty() {
        return Err("Speaker Detection received an empty WAV file.".to_string());
    }

    Ok(samples)
}

fn convert_speakrs_segments(mut segments: Vec<Segment>) -> Vec<SpeakerSegment> {
    segments.sort_by(|left, right| {
        left.start
            .total_cmp(&right.start)
            .then_with(|| left.end.total_cmp(&right.end))
    });

    // speakrs returns stable labels such as SPEAKER_00. Relabel them in order
    // of first appearance so the user sees Speaker 1, Speaker 2, ...
    let mut labels = HashMap::<String, usize>::new();
    let mut output = Vec::with_capacity(segments.len());

    for segment in segments {
        if !segment.start.is_finite()
            || !segment.end.is_finite()
            || segment.end <= segment.start
        {
            continue;
        }

        let speaker = if let Some(existing) = labels.get(&segment.speaker) {
            *existing
        } else {
            let next = labels.len();
            labels.insert(segment.speaker.clone(), next);
            next
        };

        output.push(SpeakerSegment {
            start_sec: segment.start,
            end_sec: segment.end,
            speaker,
            confidence: None,
        });
    }

    output
}

pub async fn run_speaker_diarization(
    app: AppHandle,
    logs: Arc<AppLogs>,
    session: Arc<Mutex<crate::TranscriptionSession>>,
    wav_path: &str,
    settings: &crate::settings::WhisperSettings,
) -> Result<Vec<SpeakerSegment>, String> {
    let wav_path = PathBuf::from(wav_path);

    if !wav_path.is_file() {
        return Err(format!(
            "Speaker Detection WAV does not exist: {}",
            wav_path.display()
        ));
    }

    {
        let mut lock = session
            .lock()
            .map_err(|error| format!("Session lock error: {error}"))?;

        if lock.phase != crate::SessionPhase::Idle {
            return Err(
                "Another transcription, translation, or encoding task is already running."
                    .to_string(),
            );
        }

        lock.phase = crate::SessionPhase::Diarizing;
        lock.cancel_requested = false;
        // speakrs is in-process, not a cancellable child process.
        lock.child_pid = None;
    }

    let _session_guard = SessionResetGuard {
        session: session.clone(),
    };

    let mode = execution_mode(settings);
    let mode_name = mode.as_str().to_string();
    let cache_dir = speakrs_cache_dir(&settings.models_dir);

    // speakrs' high-level pipeline performs automatic speaker counting via
    // PLDA + VBx clustering. Do not fake exact count locking.
    if settings.speaker_count > 0 {
        logs.log(
            &app,
            "Speaker",
            &format!(
                "Ignoring legacy speaker-count hint {}: speakrs is using automatic VBx speaker counting.",
                settings.speaker_count
            ),
        );
    }

    logs.log(
        &app,
        "Speaker",
        &format!(
            "Starting speakrs PLDA + VBx diarization in {mode_name} mode."
        ),
    );

    let _ = app.emit(
        "transcribe-status",
        TranscribeProgress {
            progress: 0.0,
            message: "Preparing Speaker Detection...".to_string(),
            active: true,
            stage: Some("diarizing".to_string()),
        },
    );

    let worker_app = app.clone();
    let worker_wav = wav_path.clone();
    let started = Instant::now();

    let segments = tokio::task::spawn_blocking(move || -> Result<Vec<SpeakerSegment>, String> {
        let samples = read_pcm16_mono_16khz(&worker_wav)?;

        std::fs::create_dir_all(&cache_dir).map_err(|error| {
            format!(
                "Failed to create Speaker Detection model cache '{}': {error}",
                cache_dir.display()
            )
        })?;

        let _ = worker_app.emit(
            "transcribe-status",
            TranscribeProgress {
                progress: 0.08,
                message: "Preparing speaker models...".to_string(),
                active: true,
                stage: Some("diarizing".to_string()),
            },
        );

        // ModelManager::with_cache_dir + ensure(mode) downloads the exact model
        // inventory required by the selected execution mode and returns its snapshot dir.
        let manager = ModelManager::with_cache_dir(cache_dir.clone()).map_err(|error| {
            format!("Failed to initialize speakrs model manager: {error}")
        })?;

        let model_dir = manager.ensure(mode).map_err(|error| {
            format!("Failed to prepare speakrs speaker models: {error}")
        })?;

        let _ = worker_app.emit(
            "transcribe-status",
            TranscribeProgress {
                progress: 0.18,
                message: "Detecting speakers with PLDA + VBx...".to_string(),
                active: true,
                stage: Some("diarizing".to_string()),
            },
        );

        let mut pipeline = OwnedDiarizationPipeline::from_dir(&model_dir, mode).map_err(|error| {
            format!(
                "Failed to initialize speakrs {mode_name} pipeline from '{}': {error}",
                model_dir.display()
            )
        })?;

        let result = pipeline.run(&samples).map_err(|error| {
            format!("speakrs Speaker Detection failed: {error}")
        })?;

        let converted = convert_speakrs_segments(result.discrete_diarization.to_segments());

        if converted.is_empty() {
            return Err(
                "Speaker Detection completed but returned no speaker segments.".to_string(),
            );
        }

        Ok(converted)
    })
    .await
    .map_err(|error| format!("Speaker Detection worker failed: {error}"))??;

    // In-process speakrs cannot be forcibly killed mid-inference. A cancel
    // request is honored immediately after the blocking diarization call returns.
    if session
        .lock()
        .map(|lock| lock.cancel_requested)
        .unwrap_or(false)
    {
        return Err("Speaker Detection was cancelled by the user.".to_string());
    }

    let speaker_count = segments
        .iter()
        .map(|segment| segment.speaker)
        .max()
        .map(|speaker| speaker + 1)
        .unwrap_or(0);

    logs.log(
        &app,
        "Speaker",
        &format!(
            "speakrs diarization complete: {speaker_count} speakers, {} ranges, {:.2}s",
            segments.len(),
            started.elapsed().as_secs_f64()
        ),
    );

    let _ = app.emit(
        "transcribe-status",
        TranscribeProgress {
            progress: 1.0,
            message: format!(
                "Detected {speaker_count} speaker{}",
                if speaker_count == 1 { "" } else { "s" }
            ),
            active: false,
            stage: Some("diarization_complete".to_string()),
        },
    );

    Ok(segments)
}

#[derive(Debug, Clone)]
struct TimedWord {
    text: String,
    start_sec: f64,
    end_sec: f64,
}

fn is_special_token(text: &str) -> bool {
    let text = text.trim();

    (text.starts_with("[_") && text.ends_with(']') && !text.contains(char::is_whitespace))
        || (text.starts_with("<|") && text.ends_with("|>"))
        || matches!(
            text,
            "[BLANK_AUDIO]" | "[SILENCE]" | "[MUSIC]" | "[Music]" | "[music]"
        )
}

fn is_punctuation_only(text: &str) -> bool {
    text.chars().all(|character| {
        character.is_ascii_punctuation()
            || matches!(
                character,
                '…' | '—'
                    | '–'
                    | '“'
                    | '”'
                    | '‘'
                    | '’'
                    | '。'
                    | '，'
                    | '！'
                    | '？'
                    | '；'
                    | '：'
                    | '、'
            )
    })
}

fn parse_whisper_words(document: &Value) -> Vec<TimedWord> {
    let Some(transcription) = document.get("transcription").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut words: Vec<TimedWord> = Vec::new();

    for segment in transcription {
        let Some(tokens) = segment.get("tokens").and_then(Value::as_array) else {
            continue;
        };

        for token in tokens {
            let Some(raw_text) = token.get("text").and_then(Value::as_str) else {
                continue;
            };

            if raw_text.trim().is_empty() || is_special_token(raw_text) {
                continue;
            }

            let Some(offsets) = token.get("offsets") else {
                continue;
            };

            let Some(start_ms) = offsets.get("from").and_then(Value::as_i64) else {
                continue;
            };
            let Some(end_ms) = offsets.get("to").and_then(Value::as_i64) else {
                continue;
            };

            let text = raw_text.trim();
            if text.is_empty() {
                continue;
            }

            if is_punctuation_only(text) {
                if let Some(previous) = words.last_mut() {
                    previous.text.push_str(text);
                }
                continue;
            }

            let start_sec = start_ms.max(0) as f64 / 1000.0;
            let end_sec = end_ms.max(start_ms + 1) as f64 / 1000.0;
            let starts_with_space = raw_text.chars().next().is_some_and(char::is_whitespace);

            if starts_with_space || words.is_empty() {
                words.push(TimedWord {
                    text: text.to_string(),
                    start_sec,
                    end_sec,
                });
            } else if let Some(previous) = words.last_mut() {
                previous.text.push_str(text);
                previous.end_sec = previous.end_sec.max(end_sec);
            }
        }
    }

    words
}

fn overlap_duration(start_a: f64, end_a: f64, start_b: f64, end_b: f64) -> f64 {
    (end_a.min(end_b) - start_a.max(start_b)).max(0.0)
}

fn nearest_speaker(midpoint: f64, segments: &[SpeakerSegment]) -> Option<usize> {
    segments
        .iter()
        .min_by(|left, right| {
            let distance = |segment: &SpeakerSegment| {
                if midpoint < segment.start_sec {
                    segment.start_sec - midpoint
                } else if midpoint > segment.end_sec {
                    midpoint - segment.end_sec
                } else {
                    0.0
                }
            };

            distance(left).total_cmp(&distance(right))
        })
        .map(|segment| segment.speaker)
}

fn speaker_for_word(word: &TimedWord, segments: &[SpeakerSegment]) -> Option<usize> {
    // WhisperX-style assignment: sum temporal intersection by speaker and
    // select the speaker with greatest overlap for this exact Whisper word.
    let mut overlaps = BTreeMap::<usize, f64>::new();

    for segment in segments {
        let overlap = overlap_duration(
            word.start_sec,
            word.end_sec,
            segment.start_sec,
            segment.end_sec,
        );

        if overlap > 0.0 {
            *overlaps.entry(segment.speaker).or_default() += overlap;
        }
    }

    if let Some((&speaker, _)) = overlaps
        .iter()
        .max_by(|left, right| left.1.total_cmp(right.1))
    {
        return Some(speaker);
    }

    // Preserve words that land in tiny diarization gaps.
    nearest_speaker((word.start_sec + word.end_sec) / 2.0, segments)
}

fn append_word(output: &mut String, word: &str) {
    if output.is_empty() {
        output.push_str(word);
        return;
    }

    let attaches_without_space = word.chars().next().is_some_and(|character| {
        character.is_ascii_punctuation()
            || matches!(
                character,
                '…' | '。' | '，' | '！' | '？' | '；' | '：' | '、'
            )
    });

    if !attaches_without_space {
        output.push(' ');
    }

    output.push_str(word);
}

pub fn build_speaker_transcript_from_whisper_json(
    json_path: &Path,
    segments: &[SpeakerSegment],
) -> Result<String, String> {
    if segments.is_empty() {
        return Err("No speaker ranges were supplied.".to_string());
    }

    let data = std::fs::read_to_string(json_path).map_err(|error| {
        format!(
            "Failed to read Whisper timing JSON '{}': {error}",
            json_path.display()
        )
    })?;

    let document: Value = serde_json::from_str(&data)
        .map_err(|error| format!("Invalid Whisper timing JSON: {error}"))?;

    let words = parse_whisper_words(&document);
    if words.is_empty() {
        return Err("Whisper JSON did not contain usable word timestamps.".to_string());
    }

    let mut turns: Vec<(usize, String)> = Vec::new();

    for word in words {
        let speaker = speaker_for_word(&word, segments).unwrap_or(0);

        if let Some((last_speaker, text)) = turns.last_mut() {
            if *last_speaker == speaker {
                append_word(text, &word.text);
                continue;
            }
        }

        turns.push((speaker, word.text));
    }

    let mut output = String::new();

    for (index, (speaker, text)) in turns.iter().enumerate() {
        if index > 0 {
            output.push_str("\n\n");
        }

        output.push_str(&format!("Speaker {}: {}", speaker + 1, text.trim()));
    }

    output.push('\n');
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assignment_uses_greatest_overlap() {
        let word = TimedWord {
            text: "hello".into(),
            start_sec: 1.0,
            end_sec: 2.0,
        };

        let segments = vec![
            SpeakerSegment {
                start_sec: 0.0,
                end_sec: 1.25,
                speaker: 0,
                confidence: None,
            },
            SpeakerSegment {
                start_sec: 1.25,
                end_sec: 2.0,
                speaker: 1,
                confidence: None,
            },
        ];

        assert_eq!(speaker_for_word(&word, &segments), Some(1));
    }

    #[test]
    fn nearest_speaker_fills_small_gap() {
        let word = TimedWord {
            text: "okay".into(),
            start_sec: 2.1,
            end_sec: 2.2,
        };

        let segments = vec![
            SpeakerSegment {
                start_sec: 0.0,
                end_sec: 2.0,
                speaker: 0,
                confidence: None,
            },
            SpeakerSegment {
                start_sec: 3.0,
                end_sec: 4.0,
                speaker: 1,
                confidence: None,
            },
        ];

        assert_eq!(speaker_for_word(&word, &segments), Some(0));
    }

    #[test]
    fn whisper_control_tokens_are_filtered() {
        assert!(is_special_token("[_TT_400]"));
        assert!(is_special_token("[_SOT_]"));
        assert!(is_special_token("<|endoftext|>"));
        assert!(!is_special_token("hello"));
    }
}
