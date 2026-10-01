#[derive(Debug, Clone, PartialEq)]
pub struct TimedWord {
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub segment_index: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum BoundaryKind {
    None,
    Segment,
    Clause,
    Pause,
    Sentence,
    HardPause,
}

impl BoundaryKind {
    pub fn is_hard(self) -> bool {
        matches!(self, Self::Sentence | Self::HardPause)
    }

    pub fn reward(self) -> f64 {
        match self {
            Self::None => 0.0,
            Self::Segment => 3.0,
            Self::Clause => 13.0,
            Self::Pause => 18.0,
            Self::Sentence => 38.0,
            Self::HardPause => 44.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Boundary {
    pub kind: BoundaryKind,
    pub gap_ms: i64,
}

impl Boundary {
    pub fn none() -> Self {
        Self {
            kind: BoundaryKind::None,
            gap_ms: 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct CueDraft {
    pub first_word: usize,
    pub last_word: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SubtitleCue {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct SubtitleProfile {
    // Reading-speed rules. Subtitle Edit's current default profile exposes
    // optimal 15 CPS and max 25 CPS. We use those as optimization targets
    // rather than rigid segmentation thresholds.
    pub optimal_cps: f64,
    pub max_cps: f64,

    // Display/timing rules.
    pub preferred_duration_ms: i64,
    pub min_duration_ms: i64,
    pub max_duration_ms: i64,
    pub min_gap_ms: i64,
    pub cue_lead_ms: i64,
    pub cue_tail_ms: i64,

    // Pause rules. stable-ts' default regroup includes a 0.5s word-gap split.
    // We use 500 ms as a hard speech boundary and a softer 250 ms candidate.
    pub hard_pause_ms: i64,
    pub soft_pause_ms: i64,

    // Layout rules. 42 chars is the common Latin-script line target used by
    // auto-subtitles and professional subtitle tooling.
    pub max_line_chars: usize,
    pub preferred_line_chars: usize,
    pub max_lines: usize,
    pub prefer_single_line: bool,
    pub no_space_language: bool,

    // Search guardrail. Every word boundary remains a candidate; this only
    // prevents pathological O(n^2) work on unpunctuated transcripts.
    pub max_words_per_cue: usize,
}

impl SubtitleProfile {
    pub fn movie(language: &str) -> Self {
        let language = language.to_ascii_lowercase();

        let (max_line_chars, preferred_line_chars, no_space_language) = match language.as_str() {
            "zh" | "ja" | "yue" => (18, 16, true),
            "ko" => (20, 18, true),
            "th" | "lo" | "km" | "my" => (32, 28, true),
            _ => (42, 36, false),
        };

        Self {
            optimal_cps: 15.0,
            max_cps: 25.0,

            preferred_duration_ms: 2_200,
            min_duration_ms: 850,
            max_duration_ms: 6_000,
            min_gap_ms: 80,
            cue_lead_ms: 30,
            cue_tail_ms: 120,

            hard_pause_ms: 500,
            soft_pause_ms: 250,

            max_line_chars,
            preferred_line_chars,
            max_lines: 2,
            prefer_single_line: true,
            no_space_language,

            max_words_per_cue: 18,
        }
    }
}
