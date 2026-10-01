use super::*;
use serde_json::{json, Value};

fn token(text: &str, from: i64, to: i64) -> Value {
    json!({
        "text": text,
        "offsets": {
            "from": from,
            "to": to
        }
    })
}

fn document(tokens: Vec<Value>) -> String {
    json!({
        "result": {
            "language": "en"
        },
        "transcription": [
            {
                "tokens": tokens
            }
        ]
    })
    .to_string()
}

fn cue_texts(srt: &str) -> Vec<String> {
    srt.split("\n\n")
        .filter_map(|block| {
            let mut lines = block.lines();
            let _number = lines.next()?;
            let _time = lines.next()?;
            let text = lines.collect::<Vec<_>>().join("\n");
            (!text.is_empty()).then_some(text)
        })
        .collect()
}

#[test]
fn complete_short_sentence_stays_whole() {
    let json = document(vec![
        token(" This", 100, 300),
        token(" works", 320, 550),
        token(" really", 570, 800),
        token(" well", 820, 1_050),
        token(".", 1_050, 1_100),
    ]);

    let srt = build_srt_from_json_str(&json, 0).unwrap();
    let cues = cue_texts(&srt);

    assert_eq!(cues, vec!["This works really well."]);
}

#[test]
fn sentence_boundary_never_leaks_next_sentence() {
    let json = document(vec![
        token(" Hello", 100, 350),
        token(" there", 360, 650),
        token(".", 650, 800),
        token(" Next", 1_000, 1_200),
        token(" sentence", 1_220, 1_600),
        token(".", 1_600, 1_700),
    ]);

    let srt = build_srt_from_json_str(&json, 0).unwrap();

    assert!(srt.contains("Hello there."));
    assert!(srt.contains("Next sentence."));
    assert!(!srt.contains("Hello there. Next"));
}

#[test]
fn abbreviation_does_not_force_sentence_split() {
    let json = document(vec![
        token(" Dr", 100, 250),
        token(".", 250, 280),
        token(" Smith", 300, 500),
        token(" arrived", 520, 800),
        token(".", 800, 850),
    ]);

    let srt = build_srt_from_json_str(&json, 0).unwrap();
    let cues = cue_texts(&srt);

    assert_eq!(cues, vec!["Dr. Smith arrived."]);
}

#[test]
fn slow_speech_with_half_second_gaps_can_be_word_sized() {
    let json = document(vec![
        token(" Slowly", 100, 300),
        token(" spoken", 900, 1_150),
        token(" words", 1_750, 2_000),
        token(".", 2_000, 2_050),
    ]);

    let srt = build_srt_from_json_str(&json, 0).unwrap();
    let cues = cue_texts(&srt);

    assert_eq!(cues, vec!["Slowly", "spoken", "words."]);
}

#[test]
fn fast_long_speech_advances_in_multiple_single_line_cues() {
    let mut tokens = Vec::new();
    let words = [
        " This",
        " is",
        " a",
        " deliberately",
        " fast",
        " sentence",
        " containing",
        " enough",
        " words",
        " that",
        " it",
        " should",
        " advance",
        " through",
        " several",
        " compact",
        " subtitles",
        " instead",
        " of",
        " becoming",
        " a",
        " giant",
        " block",
    ];

    let mut t = 0;
    for word in words {
        tokens.push(token(word, t, t + 120));
        t += 130;
    }
    tokens.push(token(".", t, t + 40));

    let srt = build_srt_from_json_str(&document(tokens), 0).unwrap();
    let cues = cue_texts(&srt);

    assert!(cues.len() >= 3);

    for cue in cues {
        assert!(
            cue.lines().all(|line| line.chars().count() <= 42),
            "cue line too long: {cue}"
        );
    }
}

#[test]
fn rapid_phrase_avoids_one_word_flashes_when_no_pause_requires_them() {
    let json = document(vec![
        token(" one", 0, 120),
        token(" two", 130, 250),
        token(" three", 260, 380),
        token(" four", 390, 510),
        token(" five", 520, 640),
        token(" six", 650, 770),
        token(" seven", 780, 900),
        token(" eight", 910, 1_030),
        token(".", 1_030, 1_080),
    ]);

    let srt = build_srt_from_json_str(&json, 0).unwrap();
    let cues = cue_texts(&srt);

    assert!(
        cues.iter().all(|cue| cue.split_whitespace().count() >= 2),
        "unexpected one-word flash: {cues:?}"
    );
}

#[test]
fn punctuation_control_tokens_never_appear() {
    let json = document(vec![
        token(" This", 100, 300),
        token("[_TT_836]", 300, 320),
        token(" works", 340, 550),
        token(".", 550, 600),
    ]);

    let srt = build_srt_from_json_str(&json, 0).unwrap();

    assert!(!srt.contains("[_TT_"));
    assert!(srt.contains("This works."));
}

#[test]
fn punctuation_timestamp_does_not_stretch_into_silence() {
    let json = document(vec![
        token(" Hello", 100, 400),
        token(".", 1_500, 1_700),
        token(" Next", 2_000, 2_300),
        token(".", 2_300, 2_400),
    ]);

    let srt = build_srt_from_json_str(&json, 0).unwrap();

    // The first cue should end near the spoken word, not at the punctuation
    // token's artificial timestamp deep in silence.
    assert!(srt.contains("00:00:00,070 --> 00:00:00,520"));
}

#[test]
fn media_timeline_offset_is_applied() {
    let json = document(vec![token(" Hello", 0, 400), token(".", 400, 450)]);

    let srt = build_srt_from_json_str(&json, 315).unwrap();

    // +315 ms media offset minus 30 ms cue lead.
    assert!(srt.contains("00:00:00,285 -->"));
}

#[test]
fn cues_never_overlap() {
    let json = document(vec![
        token(" First", 100, 450),
        token(".", 450, 500),
        token(" Second", 560, 850),
        token(".", 850, 900),
    ]);

    let srt = build_srt_from_json_str(&json, 0).unwrap();

    let times: Vec<&str> = srt.lines().filter(|line| line.contains(" --> ")).collect();

    assert_eq!(times.len(), 2);
}

#[test]
fn cjk_output_does_not_insert_spaces() {
    let json = json!({
        "result": { "language": "ja" },
        "transcription": [{
            "tokens": [
                {"text":" 今日","offsets":{"from":100,"to":300}},
                {"text":" は","offsets":{"from":310,"to":420}},
                {"text":" いい","offsets":{"from":430,"to":600}},
                {"text":" 天気","offsets":{"from":610,"to":800}},
                {"text":" です","offsets":{"from":810,"to":950}},
                {"text":"。","offsets":{"from":950,"to":1000}}
            ]
        }]
    })
    .to_string();

    let srt = build_srt_from_json_str(&json, 0).unwrap();

    assert!(srt.contains("今日はいい天気です。"));
}
