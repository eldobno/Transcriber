use super::boundaries::clause_terminal;
use super::model::{SubtitleProfile, TimedWord};

pub fn joined_text(words: &[TimedWord], no_space_language: bool) -> String {
    if no_space_language {
        words
            .iter()
            .map(|word| word.text.as_str())
            .collect::<String>()
    } else {
        words
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

pub fn visible_char_count(text: &str) -> usize {
    text.chars()
        .filter(|character| !matches!(character, '\n' | '\r'))
        .count()
}

pub fn layout_text(text: &str, profile: &SubtitleProfile) -> String {
    if profile.no_space_language {
        return layout_no_space_text(text, profile);
    }

    if text.chars().count() <= profile.max_line_chars {
        return text.to_string();
    }

    if profile.max_lines <= 1 {
        return text.to_string();
    }

    balance_two_lines(text, profile.max_line_chars).unwrap_or_else(|| text.to_string())
}

fn layout_no_space_text(text: &str, profile: &SubtitleProfile) -> String {
    let chars: Vec<char> = text.chars().collect();

    if chars.len() <= profile.max_line_chars || profile.max_lines <= 1 {
        return text.to_string();
    }

    let max_total = profile.max_line_chars * profile.max_lines;
    if chars.len() > max_total {
        return text.to_string();
    }

    let target = chars.len() / 2;
    let min = chars.len().saturating_sub(profile.max_line_chars);
    let max = profile.max_line_chars.min(chars.len().saturating_sub(1));

    let mut best: Option<(usize, i64)> = None;

    for split in min.max(1)..=max {
        let left: String = chars[..split].iter().collect();
        let right_len = chars.len() - split;

        let mut score = (split as i64 - right_len as i64).abs();

        if clause_terminal(&left) {
            score -= 12;
        }

        // Prefer a split near the visual centre when scores tie.
        score += (split as i64 - target as i64).abs() / 4;

        match best {
            Some((_, best_score)) if score >= best_score => {}
            _ => best = Some((split, score)),
        }
    }

    best.map(|(split, _)| {
        format!(
            "{}\n{}",
            chars[..split].iter().collect::<String>(),
            chars[split..].iter().collect::<String>()
        )
    })
    .unwrap_or_else(|| text.to_string())
}

fn balance_two_lines(text: &str, max_chars: usize) -> Option<String> {
    let words: Vec<&str> = text.split_whitespace().collect();

    if words.len() < 2 {
        return None;
    }

    let mut best: Option<(usize, i64)> = None;

    for split in 1..words.len() {
        let left = words[..split].join(" ");
        let right = words[split..].join(" ");

        let left_len = left.chars().count();
        let right_len = right.chars().count();

        if left_len > max_chars || right_len > max_chars {
            continue;
        }

        // Borrow the useful idea from auto-subtitles: balance the two lines,
        // but strongly prefer a grammatical/punctuation boundary.
        let mut score = left_len.abs_diff(right_len) as i64;

        if clause_terminal(&left) {
            score -= 12;
        }

        // Avoid an orphan one-word second line whenever possible.
        if words.len() - split == 1 {
            score += 20;
        }

        match best {
            Some((_, best_score)) if score >= best_score => {}
            _ => best = Some((split, score)),
        }
    }

    best.map(|(split, _)| format!("{}\n{}", words[..split].join(" "), words[split..].join(" ")))
}
