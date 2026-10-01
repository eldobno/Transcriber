use super::layout::{joined_text, layout_text};
use super::model::{CueDraft, SubtitleCue, SubtitleProfile, TimedWord};

pub fn finalize_cues(
    words: &[TimedWord],
    drafts: &[CueDraft],
    profile: &SubtitleProfile,
    timeline_offset_ms: i64,
) -> Vec<SubtitleCue> {
    let mut cues = Vec::with_capacity(drafts.len());

    for draft in drafts {
        let slice = &words[draft.first_word..=draft.last_word];

        if slice.is_empty() {
            continue;
        }

        let raw_text = joined_text(slice, profile.no_space_language);
        let text = layout_text(raw_text.trim(), profile);

        if text.trim().is_empty() {
            continue;
        }

        let first = &slice[0];
        let last = &slice[slice.len() - 1];

        let start_ms = first
            .start_ms
            .saturating_add(timeline_offset_ms)
            .saturating_sub(profile.cue_lead_ms)
            .max(0);

        let next_word_start = words
            .get(draft.last_word + 1)
            .map(|word| word.start_ms.saturating_add(timeline_offset_ms));

        let natural_end = last
            .end_ms
            .saturating_add(timeline_offset_ms)
            .saturating_add(profile.cue_tail_ms);

        let desired_min_end = start_ms.saturating_add(profile.min_duration_ms);

        let silence_after = words
            .get(draft.last_word + 1)
            .map(|word| word.start_ms - last.end_ms)
            .unwrap_or(i64::MAX);

        let mut end_ms = if silence_after >= profile.soft_pause_ms {
            // Real pause: text should clear soon after the speaker stops.
            natural_end
        } else {
            natural_end.max(desired_min_end)
        };

        end_ms = end_ms.min(start_ms.saturating_add(profile.max_duration_ms));

        if let Some(next_start) = next_word_start {
            end_ms = end_ms.min(next_start.saturating_sub(profile.min_gap_ms));
        }

        end_ms = end_ms.max(start_ms.saturating_add(120));

        cues.push(SubtitleCue {
            start_ms,
            end_ms,
            text,
        });
    }

    enforce_non_overlap(&mut cues, profile);
    cues
}

fn enforce_non_overlap(cues: &mut [SubtitleCue], profile: &SubtitleProfile) {
    for index in 0..cues.len().saturating_sub(1) {
        let next_start = cues[index + 1].start_ms;
        let latest_end = next_start.saturating_sub(profile.min_gap_ms);

        if cues[index].end_ms > latest_end {
            cues[index].end_ms = latest_end.max(cues[index].start_ms + 120);
        }
    }
}
