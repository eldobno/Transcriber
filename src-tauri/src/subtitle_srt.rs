use super::model::SubtitleCue;

pub fn render_srt(cues: &[SubtitleCue]) -> String {
    let mut output = String::new();

    for (index, cue) in cues.iter().enumerate() {
        output.push_str(&(index + 1).to_string());
        output.push('\n');
        output.push_str(&format!(
            "{} --> {}\n",
            format_srt_time(cue.start_ms),
            format_srt_time(cue.end_ms)
        ));
        output.push_str(&cue.text);
        output.push_str("\n\n");
    }

    output
}

pub fn format_srt_time(milliseconds: i64) -> String {
    let milliseconds = milliseconds.max(0);

    let hours = milliseconds / 3_600_000;
    let minutes = (milliseconds % 3_600_000) / 60_000;
    let seconds = (milliseconds % 60_000) / 1_000;
    let millis = milliseconds % 1_000;

    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}
