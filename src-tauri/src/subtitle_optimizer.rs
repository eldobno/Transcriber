use super::boundaries::ends_on_weak_function_word;
use super::layout::{joined_text, visible_char_count};
use super::model::{Boundary, BoundaryKind, CueDraft, SubtitleProfile, TimedWord};

const INF: f64 = 1.0e30;

pub fn optimize_cues(
    words: &[TimedWord],
    boundaries: &[Boundary],
    profile: &SubtitleProfile,
    language: &str,
) -> Vec<CueDraft> {
    if words.is_empty() {
        return Vec::new();
    }

    let n: usize = words.len();

    let mut best_cost = vec![INF; n + 1];
    let mut previous: Vec<Option<usize>> = vec![None; n + 1];
    best_cost[0] = 0.0;

    for end in 1..=n {
        let start_floor = end.saturating_sub(profile.max_words_per_cue);

        for start in (start_floor..end).rev() {
            if best_cost[start] >= INF {
                continue;
            }

            if crosses_hard_boundary(boundaries, start, end) {
                break;
            }

            let Some(cost) = cue_cost(words, boundaries, profile, language, start, end) else {
                continue;
            };

            let total = best_cost[start] + cost;

            if total < best_cost[end] {
                best_cost[end] = total;
                previous[end] = Some(start);
            }
        }
    }

    // The hard constraints are intentionally generous enough that this should
    // never fail. Fall back to one-word cues instead of dropping transcript
    // content if an unexpected timestamp/pathology slips through.
    if previous[n].is_none() {
        return (0..n)
            .map(|index| CueDraft {
                first_word: index,
                last_word: index,
            })
            .collect();
    }

    let mut drafts = Vec::new();
    let mut cursor = n;

    while cursor > 0 {
        let start = previous[cursor].unwrap_or(cursor - 1);

        drafts.push(CueDraft {
            first_word: start,
            last_word: cursor - 1,
        });

        cursor = start;
    }

    drafts.reverse();
    drafts
}

fn crosses_hard_boundary(boundaries: &[Boundary], start: usize, end_exclusive: usize) -> bool {
    if end_exclusive <= start + 1 {
        return false;
    }

    boundaries[start..end_exclusive - 1]
        .iter()
        .any(|boundary| boundary.kind.is_hard())
}

fn cue_cost(
    words: &[TimedWord],
    boundaries: &[Boundary],
    profile: &SubtitleProfile,
    language: &str,
    start: usize,
    end_exclusive: usize,
) -> Option<f64> {
    let slice = &words[start..end_exclusive];
    let first = slice.first()?;
    let last = slice.last()?;

    let text = joined_text(slice, profile.no_space_language);
    let chars = visible_char_count(&text);
    let word_count = slice.len();

    let speech_duration_ms = (last.end_ms - first.start_ms).max(120);

    if speech_duration_ms > profile.max_duration_ms + 1_500 {
        return None;
    }

    let hard_char_limit = profile.max_line_chars * profile.max_lines;

    if chars > hard_char_limit && word_count > 1 {
        return None;
    }

    // The Movie profile is intentionally single-line-first. When that
    // preference is enabled, do not let the optimizer "solve" fast speech by
    // creating a dense two-line block. It must advance through smaller cues
    // instead. A single unusually long word is still allowed through so we
    // never lose transcript content.
    if profile.prefer_single_line && chars > profile.max_line_chars && word_count > 1 {
        return None;
    }

    let next_start = words.get(end_exclusive).map(|word| word.start_ms);

    let display_duration_ms =
        estimated_display_duration_ms(first.start_ms, last.end_ms, next_start, profile);

    let display_seconds = (display_duration_ms.max(120) as f64) / 1000.0;
    let cps = chars as f64 / display_seconds;

    let boundary = boundaries
        .get(end_exclusive - 1)
        .map(|boundary| boundary.kind)
        .unwrap_or(BoundaryKind::None);

    let speech_seconds = speech_duration_ms as f64 / 1000.0;
    let words_per_second = word_count as f64 / speech_seconds.max(0.15);

    let mut cost = 0.0;

    // -----------------------------------------------------------------
    // Reading speed — modelled after professional CPS constraints.
    // -----------------------------------------------------------------
    if cps > profile.max_cps {
        let excess = cps - profile.max_cps;
        cost += 70.0 + excess * excess * 2.5;
    } else if cps > profile.optimal_cps {
        let excess = cps - profile.optimal_cps;
        cost += excess * excess * 0.65;
    }

    // -----------------------------------------------------------------
    // Visual density / line length.
    //
    // A single line is strongly preferred. Two lines remain an emergency
    // fallback for a grammatical phrase that cannot be split gracefully.
    // -----------------------------------------------------------------
    if chars > profile.max_line_chars {
        let over = (chars - profile.max_line_chars) as f64;
        cost += if profile.prefer_single_line {
            80.0 + over * 3.5
        } else {
            25.0 + over * 1.5
        };
    } else if chars > profile.preferred_line_chars {
        let over = (chars - profile.preferred_line_chars) as f64;
        cost += over * 1.3;
    }

    // -----------------------------------------------------------------
    // Cue duration.
    //
    // This is the adaptive fast/slow speech behaviour:
    // - slow speech + real pauses becomes short/small cues because pauses
    //   are hard boundaries;
    // - fast continuous speech naturally produces several ~1–2s cues,
    //   instead of a giant two-line block that lags behind the voice.
    // -----------------------------------------------------------------
    if display_duration_ms < profile.min_duration_ms {
        let shortage = (profile.min_duration_ms - display_duration_ms) as f64;
        cost += (shortage / 120.0).powi(2) * 7.0;
    }

    // Adapt the preferred cue duration to how quickly the speaker is talking.
    //
    // Fast speech should advance through short cues instead of accumulating a
    // large block on screen. Slow speech can keep a cue visible longer when
    // there is no real pause forcing a boundary.
    let adaptive_preferred_duration_ms = if words_per_second >= 5.0 {
        1_050
    } else if words_per_second >= 4.0 {
        1_250
    } else if words_per_second >= 3.2 {
        1_550
    } else if words_per_second <= 1.4 {
        2_700
    } else if words_per_second <= 2.0 {
        2_450
    } else {
        profile.preferred_duration_ms
    };

    let preferred_delta = (display_duration_ms - adaptive_preferred_duration_ms).abs() as f64;

    // Don't over-punish a complete sentence just because it is short/long,
    // but never let that sentence reward override the one-line/readability
    // constraints above.
    let sentence_discount = if boundary == BoundaryKind::Sentence {
        0.35
    } else {
        1.0
    };

    cost += (preferred_delta / 700.0).powi(2) * 6.5 * sentence_discount;

    if display_duration_ms > profile.max_duration_ms {
        let excess = (display_duration_ms - profile.max_duration_ms) as f64;
        cost += 100.0 + (excess / 250.0).powi(2) * 10.0;
    }

    // -----------------------------------------------------------------
    // Avoid ugly fragments / one-word flashes.
    // -----------------------------------------------------------------
    if word_count == 1 {
        cost += match boundary {
            BoundaryKind::Sentence | BoundaryKind::HardPause => 15.0,
            _ => 95.0,
        };
    } else if word_count == 2 {
        cost += 9.0;
    }

    // Very fast speech benefits from smaller visual chunks. This does not
    // pretend that splitting can magically reduce CPS; it simply prevents a
    // fast sentence from becoming a visually dense block.
    if words_per_second >= 4.0 && chars > 30 {
        cost += ((chars - 30) as f64).powi(2) * 0.35;
    } else if words_per_second >= 3.2 && chars > 34 {
        cost += ((chars - 34) as f64).powi(2) * 0.20;
    }

    // -----------------------------------------------------------------
    // Linguistic / acoustic boundary preference.
    //
    // stable-ts and auto-subtitles both prioritize punctuation and speech
    // gaps before arbitrary length splitting.
    // -----------------------------------------------------------------
    cost -= boundary.reward();

    let gap_ms = boundaries
        .get(end_exclusive - 1)
        .map(|boundary| boundary.gap_ms)
        .unwrap_or(0);

    if gap_ms > 0 {
        cost -= (gap_ms.min(500) as f64 / 500.0) * 10.0;
    }

    if ends_on_weak_function_word(&last.text, language)
        && !matches!(boundary, BoundaryKind::Sentence | BoundaryKind::HardPause)
    {
        cost += 18.0;
    }

    // Prefer complete short sentences where they already fit comfortably.
    if boundary == BoundaryKind::Sentence
        && chars <= profile.max_line_chars
        && cps <= profile.max_cps
    {
        cost -= 18.0;
    }

    Some(cost.max(-80.0))
}

fn estimated_display_duration_ms(
    first_start_ms: i64,
    last_end_ms: i64,
    next_start_ms: Option<i64>,
    profile: &SubtitleProfile,
) -> i64 {
    let natural_end = last_end_ms.saturating_add(profile.cue_tail_ms);
    let desired_min_end = first_start_ms.saturating_add(profile.min_duration_ms);

    let mut end = natural_end.max(desired_min_end);

    if let Some(next_start) = next_start_ms {
        let available_end = next_start.saturating_sub(profile.min_gap_ms);

        // If there is a meaningful silence after this phrase, do not use that
        // silence merely to satisfy minimum display duration. This is what
        // makes slow, deliberate speech disappear during real pauses.
        let silence_after = next_start - last_end_ms;

        if silence_after >= profile.soft_pause_ms {
            end = natural_end.min(available_end);
        } else {
            end = end.min(available_end);
        }
    }

    (end - first_start_ms).max(120)
}
