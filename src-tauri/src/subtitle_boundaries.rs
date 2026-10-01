use super::model::{Boundary, BoundaryKind, SubtitleProfile, TimedWord};

pub fn analyze_boundaries(words: &[TimedWord], profile: &SubtitleProfile) -> Vec<Boundary> {
    let mut boundaries = vec![Boundary::none(); words.len()];

    for index in 0..words.len() {
        let next = words.get(index + 1);
        let gap_ms = next
            .map(|word| (word.start_ms - words[index].end_ms).max(0))
            .unwrap_or(0);

        let kind = if sentence_terminal(words, index) {
            BoundaryKind::Sentence
        } else if next.is_some() && gap_ms >= profile.hard_pause_ms {
            BoundaryKind::HardPause
        } else if clause_terminal(&words[index].text) {
            BoundaryKind::Clause
        } else if next.is_some() && gap_ms >= profile.soft_pause_ms {
            BoundaryKind::Pause
        } else if next.is_some_and(|word| word.segment_index != words[index].segment_index) {
            BoundaryKind::Segment
        } else {
            BoundaryKind::None
        };

        boundaries[index] = Boundary { kind, gap_ms };
    }

    boundaries
}

pub fn sentence_terminal(words: &[TimedWord], index: usize) -> bool {
    let text = words[index].text.trim();

    let Some(last) = text.chars().last() else {
        return false;
    };

    if matches!(last, '?' | '!' | '？' | '！' | '。') {
        return true;
    }

    if last != '.' {
        return false;
    }

    !looks_like_special_period(text, words.get(index + 1).map(|word| word.text.as_str()))
}

fn looks_like_special_period(text: &str, next: Option<&str>) -> bool {
    let lower = text
        .trim_matches(|ch: char| matches!(ch, '"' | '\'' | ')' | ']' | '}' | '”' | '’'))
        .to_ascii_lowercase();

    const ABBREVIATIONS: &[&str] = &[
        "mr.", "mrs.", "ms.", "dr.", "prof.", "sr.", "jr.", "st.", "vs.", "etc.", "e.g.", "i.e.",
        "a.m.", "p.m.", "no.", "fig.", "inc.", "ltd.", "co.", "u.s.", "u.k.",
    ];

    if ABBREVIATIONS.contains(&lower.as_str()) {
        return true;
    }

    // Initials such as "A. Smith" should not force a sentence boundary.
    let stripped = lower.trim_end_matches('.');
    if stripped.chars().count() == 1
        && stripped.chars().all(|ch| ch.is_alphabetic())
        && next
            .and_then(|value| value.trim().chars().next())
            .is_some_and(|ch| ch.is_uppercase())
    {
        return true;
    }

    // Decimal / version-like fragments are not sentence endings.
    if stripped.chars().all(|ch| ch.is_ascii_digit()) {
        return true;
    }

    false
}

pub fn clause_terminal(text: &str) -> bool {
    text.trim_end().chars().last().is_some_and(|character| {
        matches!(
            character,
            ',' | ';' | ':' | '，' | '；' | '：' | '—' | '–' | '、'
        )
    })
}

pub fn ends_on_weak_function_word(text: &str, language: &str) -> bool {
    if !language.eq_ignore_ascii_case("en") {
        return false;
    }

    let normalized = text
        .trim_matches(|ch: char| !ch.is_alphanumeric() && ch != '\'')
        .to_ascii_lowercase();

    matches!(
        normalized.as_str(),
        "a" | "an"
            | "the"
            | "and"
            | "or"
            | "but"
            | "of"
            | "to"
            | "for"
            | "with"
            | "at"
            | "from"
            | "by"
            | "in"
            | "on"
            | "into"
            | "that"
            | "which"
            | "who"
            | "is"
            | "are"
            | "was"
            | "were"
            | "be"
            | "been"
            | "being"
    )
}
