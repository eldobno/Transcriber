#[path = "subtitle_boundaries.rs"]
mod boundaries;
#[path = "subtitle_layout.rs"]
mod layout;
#[path = "subtitle_model.rs"]
mod model;
#[path = "subtitle_optimizer.rs"]
mod optimizer;
#[path = "subtitle_srt.rs"]
mod srt;
#[path = "subtitle_timing.rs"]
mod timing;

use model::{SubtitleProfile, TimedWord};
use serde_json::Value;
use std::{fs, path::Path};

/// Build a movie-style SRT from whisper.cpp `--output-json-full`.
///
/// Design references:
/// - stable-ts (MIT): punctuation -> gap -> length regrouping philosophy
/// - mild-rgb/auto-subtitles (MIT): word-timestamp cue rebuilding,
///   punctuation-aware layout, language-specific line widths
/// - Subtitle Edit (MIT): CPS, duration, line-length and minimum-gap rules
/// - battleof3/whisper-subs (MIT): whole sentences where practical,
///   rapid cue advancement for fast speech, avoiding one-word flashes
///
/// Transcriber's implementation is native Rust and optimizes all of those
/// constraints together instead of applying a fixed "N words" threshold.
pub fn build_srt_from_whisper_json(
    json_path: &Path,
    timeline_offset_ms: i64,
) -> Result<String, String> {
    let data = fs::read_to_string(json_path).map_err(|error| {
        format!(
            "Failed to read Whisper JSON '{}': {error}",
            json_path.display()
        )
    })?;

    build_srt_from_json_str(&data, timeline_offset_ms)
}

pub fn write_srt_from_whisper_json(
    json_path: &Path,
    srt_path: &Path,
    timeline_offset_ms: i64,
) -> Result<usize, String> {
    let srt = build_srt_from_whisper_json(json_path, timeline_offset_ms)?;

    let cue_count = srt
        .lines()
        .filter(|line| line.parse::<usize>().is_ok())
        .count();

    fs::write(srt_path, srt).map_err(|error| {
        format!(
            "Failed to write generated subtitle file '{}': {error}",
            srt_path.display()
        )
    })?;

    Ok(cue_count)
}

fn build_srt_from_json_str(data: &str, timeline_offset_ms: i64) -> Result<String, String> {
    let document: Value =
        serde_json::from_str(data).map_err(|error| format!("Invalid Whisper JSON: {error}"))?;

    let language = document
        .get("result")
        .and_then(|value| value.get("language"))
        .and_then(Value::as_str)
        .unwrap_or("en");

    let profile = SubtitleProfile::movie(language);
    let mut words = parse_timed_words(&document, &profile)?;

    if words.is_empty() {
        return Err("Whisper JSON did not contain usable word/token timestamps.".to_string());
    }

    normalize_timings(&mut words);

    let boundaries = boundaries::analyze_boundaries(&words, &profile);

    let drafts = optimizer::optimize_cues(&words, &boundaries, &profile, language);

    let cues = timing::finalize_cues(&words, &drafts, &profile, timeline_offset_ms);

    if cues.is_empty() {
        return Err("Transcription contained no subtitle cues after optimization.".to_string());
    }

    Ok(srt::render_srt(&cues))
}

fn parse_timed_words(
    document: &Value,
    profile: &SubtitleProfile,
) -> Result<Vec<TimedWord>, String> {
    let segments = document
        .get("transcription")
        .and_then(Value::as_array)
        .ok_or_else(|| "Whisper JSON has no 'transcription' array.".to_string())?;

    let mut words: Vec<TimedWord> = Vec::new();

    for (segment_index, segment) in segments.iter().enumerate() {
        let Some(tokens) = segment.get("tokens").and_then(Value::as_array) else {
            continue;
        };

        for token in tokens {
            let Some(raw_text) = token.get("text").and_then(Value::as_str) else {
                continue;
            };

            if is_special_token(raw_text) {
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

            ingest_token(
                &mut words,
                raw_text,
                start_ms,
                end_ms,
                segment_index,
                profile.no_space_language,
            );
        }
    }

    Ok(words)
}

fn ingest_token(
    words: &mut Vec<TimedWord>,
    raw_text: &str,
    start_ms: i64,
    end_ms: i64,
    segment_index: usize,
    no_space_language: bool,
) {
    if raw_text.trim().is_empty() {
        return;
    }

    let starts_with_space = raw_text.chars().next().is_some_and(char::is_whitespace);
    let text = raw_text.trim().to_string();

    if text.is_empty() {
        return;
    }

    if is_punctuation_only(&text) {
        if let Some(previous) = words.last_mut() {
            previous.text.push_str(&text);

            // Do not extend the previous spoken word to a punctuation token's
            // timestamp. Whisper punctuation tokens can sit deep in silence;
            // using those timestamps was one of the causes of lingering cues.
        }
        return;
    }

    if no_space_language {
        words.push(TimedWord {
            text,
            start_ms,
            end_ms,
            segment_index,
        });
        return;
    }

    if starts_with_space || words.is_empty() {
        words.push(TimedWord {
            text,
            start_ms,
            end_ms,
            segment_index,
        });
    } else if let Some(previous) = words.last_mut() {
        // Whisper BPE suffix/apostrophe fragments often arrive without leading
        // whitespace and belong to the preceding spoken word.
        previous.text.push_str(&text);

        if end_ms > previous.end_ms {
            previous.end_ms = end_ms;
        }
    }
}

fn normalize_timings(words: &mut [TimedWord]) {
    for index in 0..words.len() {
        words[index].start_ms = words[index].start_ms.max(0);

        if words[index].end_ms <= words[index].start_ms {
            let next_start = words
                .get(index + 1)
                .map(|next| next.start_ms)
                .filter(|next| *next > words[index].start_ms);

            words[index].end_ms = next_start
                .map(|next| next.min(words[index].start_ms.saturating_add(350)))
                .unwrap_or_else(|| words[index].start_ms.saturating_add(250));
        }

        if index > 0 && words[index].start_ms < words[index - 1].start_ms {
            words[index].start_ms = words[index - 1].start_ms;
        }
    }
}

fn is_special_token(text: &str) -> bool {
    let text = text.trim();

    // whisper.cpp full JSON includes internal control/timestamp tokens such as
    // [_TT_400], [_SOT_], [_EOT_]. They are never spoken subtitle content.
    let whisper_bracket_token =
        text.starts_with("[_") && text.ends_with(']') && !text.contains(char::is_whitespace);

    whisper_bracket_token
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

#[cfg(test)]
#[path = "subtitle_tests.rs"]
mod tests;
