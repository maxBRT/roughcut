//! From transcriber messages to the saved transcript (spec 2.4.5, 3.4).
//!
//! Applied as messages arrive, so finished utterances can be handed on in batches:
//! - word ends that run on into a following pause are pulled back, using the detector's
//!   segment end and the sound level of the audio fed to the transcriber;
//! - each token's `cutBefore` is the quietest point of the gap before it; where the model's
//!   word times touch or nearly touch (they are only as fine as its time resolution), the
//!   search reaches `boundary_reach` past the recorded boundary on each side, and when it
//!   finds clearly quieter audio there the word end is pulled back and the next word's
//!   start pushed forward to that point (a word start sitting in silence is tightened);
//! - gaps longer than `pause_min` become pause tokens, tight against the speech on each side
//!   with `pause_margin` of breathing room, so cutting a pause leaves a natural gap;
//! - speech without words becomes an unrecognised token, in a paragraph of its own;
//! - utterances split at pauses, after sentence punctuation, and when they grow too long.
//!
//! Invariants of the result, for every token in order: `0 <= cutBefore`, previous
//! `end <= cutBefore <= start < end <= duration`. Utterances are numbered from 0.

use rc_types::{
    ceil_to_frame, floor_to_frame, snap_to_frame, Micros, PauseToken, Rational, SourceId, Token, Transcript,
    UnrecognisedToken, Utterance, WordToken, TRANSCRIPT_SCHEMA_VERSION,
};

use crate::levels::LevelTrack;
use crate::protocol::{Message, RangeMsg, WordMsg};

/// Tuning of transcript building. `Default` gives the values the product uses.
#[derive(Debug, Clone, PartialEq)]
pub struct BuildOptions {
    /// Gaps longer than this become pause tokens (about one second, spec 1.8 rule 2).
    pub pause_min: Micros,
    /// Silence left on each side of a pause token, so cutting it leaves breathing room.
    pub pause_margin: Micros,
    /// Shortest token.
    pub min_token: Micros,
    /// Sound kept after the last loud window of a word when its end is tightened.
    pub end_hangover: Micros,
    /// A word end is only tightened when this much or more would be removed.
    pub min_trim: Micros,
    /// How far past the end of its detector segment a word end may reach.
    pub vad_end_slack: Micros,
    /// How far on each side of the recorded boundary between two tokens the cut point
    /// search reaches (about the model's time resolution); 0 keeps the search in the gap.
    pub boundary_reach: Micros,
    /// Past this many words or this length, an utterance ends at the next clause break.
    pub soft_max_words: usize,
    pub soft_max_duration: Micros,
    /// Past this many words or this length, an utterance ends at the next token.
    pub hard_max_words: usize,
    pub hard_max_duration: Micros,
    /// When set, cut points are placed on this frame grid wherever the gap allows it.
    pub cut_grid: Option<Rational>,
}

impl Default for BuildOptions {
    fn default() -> Self {
        BuildOptions {
            pause_min: 1_000_000,
            pause_margin: 150_000,
            min_token: 20_000,
            end_hangover: 40_000,
            min_trim: 60_000,
            vad_end_slack: 100_000,
            boundary_reach: 120_000,
            soft_max_words: 40,
            soft_max_duration: 20_000_000,
            hard_max_words: 80,
            hard_max_duration: 45_000_000,
            cut_grid: None,
        }
    }
}

/// A word or a stretch of unrecognised speech, before it is placed.
#[derive(Debug, Clone)]
struct RawItem {
    start: Micros,
    end: Micros,
    /// `None` for speech without words.
    text: Option<String>,
    /// End of the detector segment the word came from.
    vad_end: Option<Micros>,
    /// Start of the message the item came from; pending items are ordered by it.
    seg_start: Micros,
}

/// Builds a [`Transcript`] incrementally from transcriber messages.
#[derive(Debug, Clone)]
pub struct TranscriptBuilder {
    source_id: SourceId,
    duration: Micros,
    opts: BuildOptions,
    model: Option<String>,
    /// Items received but not yet placed; the last one waits for its successor.
    pending: Vec<RawItem>,
    /// End of the last placed token, pauses included (0 before any).
    frontier: Micros,
    placed_any: bool,
    /// The cut point already chosen for the next token (the end of the pause before it, or
    /// the boundary found by the widened search).
    forced_cut: Option<Micros>,
    /// Where the next token starts, measured from the sound, with the recorded start of the
    /// item it was measured for: `(recorded, measured)`. Applies only to that item.
    start_hint: Option<(Micros, Micros)>,
    current: Vec<Token>,
    finished: Vec<Utterance>,
    released: usize,
    /// Every range a message reported as speech (segments and speech without words).
    reported: Vec<(Micros, Micros)>,
    complete: bool,
    warnings: Vec<String>,
}

impl TranscriptBuilder {
    /// A builder for one source of `duration` microseconds.
    pub fn new(source_id: impl Into<SourceId>, duration: Micros, opts: BuildOptions) -> Self {
        TranscriptBuilder {
            source_id: source_id.into(),
            duration: duration.max(0),
            opts,
            model: None,
            pending: Vec::new(),
            frontier: 0,
            placed_any: false,
            forced_cut: None,
            start_hint: None,
            current: Vec::new(),
            finished: Vec::new(),
            released: 0,
            reported: Vec::new(),
            complete: false,
            warnings: Vec::new(),
        }
    }

    /// Records the model name from the `ready` message.
    pub fn set_model(&mut self, model: impl Into<String>) {
        self.model = Some(model.into());
    }

    /// Applies one transcriber message. `levels` is the sound level of the audio fed so far.
    /// `progress` and `error` change nothing here.
    pub fn push_message(&mut self, msg: &Message, levels: &LevelTrack) {
        match msg {
            Message::Ready { model, .. } => self.set_model(model.clone()),
            Message::Segment { start, end, words } => self.push_segment(*start, *end, words, levels),
            Message::SpeechWithoutWords { start, end } => self.push_speech_without_words(*start, *end, levels),
            Message::Done { speech_ranges } => self.finish(speech_ranges, levels),
            Message::Progress { .. } | Message::Error { .. } => {}
        }
    }

    /// One detector segment with its words. A segment without words counts as speech without words.
    pub fn push_segment(&mut self, start: Micros, end: Micros, words: &[WordMsg], levels: &LevelTrack) {
        if self.complete {
            return;
        }
        self.reported.push((start, end));
        let mut usable: Vec<&WordMsg> = words.iter().collect();
        usable.sort_by_key(|w| w.start);
        if usable.is_empty() {
            self.enqueue(RawItem { start, end, text: None, vad_end: None, seg_start: start });
        }
        for w in usable {
            let text = w.text.trim();
            let text = if text.is_empty() { None } else { Some(text.to_string()) };
            self.enqueue(RawItem { start: w.start, end: w.end, text, vad_end: Some(end), seg_start: start });
        }
        self.place_ready(levels);
    }

    /// A stretch the detector heard as speech and the model returned nothing for.
    pub fn push_speech_without_words(&mut self, start: Micros, end: Micros, levels: &LevelTrack) {
        if self.complete {
            return;
        }
        self.reported.push((start, end));
        self.enqueue(RawItem { start, end, text: None, vad_end: None, seg_start: start });
        self.place_ready(levels);
    }

    /// Input ended (`done`): places everything left, adds unrecognised tokens for detector
    /// ranges no message covered, a trailing pause, and closes the last utterance.
    pub fn finish(&mut self, speech_ranges: &[RangeMsg], levels: &LevelTrack) {
        if self.complete {
            return;
        }
        // First what was already final, so the result does not depend on when the caller
        // last called `advance`.
        self.place_ready(levels);
        for r in speech_ranges {
            let covered = self.reported.iter().any(|&(a, b)| a < r.end && r.start < b);
            if covered || r.end <= r.start {
                continue;
            }
            if r.end > self.frontier + self.opts.min_token {
                // Starts no earlier than what is already final (place() moves it up).
                self.enqueue(RawItem { start: r.start, end: r.end, text: None, vad_end: None, seg_start: r.start });
            } else {
                self.warnings.push(format!(
                    "speech range {}..{} was reported only in `done`, after later text was final",
                    r.start, r.end
                ));
            }
        }
        while !self.pending.is_empty() {
            let item = self.pending.remove(0);
            let next = self.pending.first().map(|n| (n.start, n.end));
            self.place(item, next, levels);
        }
        let last_is_pause = matches!(self.current.last(), Some(Token::Pause(_))) || self.forced_cut.is_some();
        if self.placed_any && !last_is_pause && self.duration - self.frontier > self.opts.pause_min {
            // Silence at the end of the source: a trailing pause chip.
            let start = self.frontier + self.opts.pause_margin;
            let start = self.on_grid_up(start, self.duration);
            self.current.push(Token::Pause(PauseToken { start, end: self.duration, cut_before: start }));
        }
        self.close_current();
        self.complete = true;
    }

    /// Utterances that became final since the last call, in order (for `transcript_appended`).
    pub fn take_final_utterances(&mut self) -> Vec<Utterance> {
        let out = self.finished[self.released..].to_vec();
        self.released = self.finished.len();
        out
    }

    /// True once [`finish`](Self::finish) has run.
    pub fn is_complete(&self) -> bool {
        self.complete
    }

    /// Problems in the transcriber's output that were worked around.
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// The transcript so far: every final utterance, `complete` once finished.
    pub fn transcript(&self) -> Transcript {
        Transcript {
            schema_version: TRANSCRIPT_SCHEMA_VERSION,
            source_id: self.source_id.clone(),
            model: self.model.clone().unwrap_or_default(),
            complete: self.complete,
            utterances: self.finished.clone(),
        }
    }

    /// Consumes the builder and returns the transcript.
    pub fn into_transcript(self) -> Transcript {
        Transcript {
            schema_version: TRANSCRIPT_SCHEMA_VERSION,
            source_id: self.source_id,
            model: self.model.unwrap_or_default(),
            complete: self.complete,
            utterances: self.finished,
        }
    }

    fn enqueue(&mut self, item: RawItem) {
        // Whole messages are kept in order of their start, each message's items in time
        // order (equal keys keep arrival order). Messages arriving in order are therefore
        // placed in arrival order, so the result does not depend on how long items wait
        // for their sound level; a message that arrives late still slots in by time while
        // its neighbours are pending.
        let at = self.pending.partition_point(|p| p.seg_start <= item.seg_start);
        self.pending.insert(at, item);
    }

    /// Places whatever has become final since the last message: call it when more audio
    /// has been measured, so utterances waiting for the sound level of their last word are
    /// released without waiting for the next message.
    pub fn advance(&mut self, levels: &LevelTrack) {
        if !self.complete {
            self.place_ready(levels);
        }
    }

    /// Places every pending item whose successor is known and whose sound is measured
    /// (so the result is the same as when building from the finished audio).
    fn place_ready(&mut self, levels: &LevelTrack) {
        // The boundary search after an item reads up to twice `boundary_reach` past it.
        while self.pending.len() >= 2
            && levels.covers(
                (self.pending[0].end.max(self.pending[1].start) + 2 * self.opts.boundary_reach.max(0))
                    .min(self.duration),
            )
        {
            let item = self.pending.remove(0);
            let next = self.pending.first().map(|n| (n.start, n.end));
            self.place(item, next, levels);
        }
    }

    /// Places one item. `next` is the start and end of the item after it, if known; the
    /// boundary after this item (pause, cut point, end of utterance) is decided here, so an
    /// utterance is final as soon as its successor is known.
    fn place(&mut self, item: RawItem, next: Option<(Micros, Micros)>, levels: &LevelTrack) {
        let o = self.opts.clone();
        let next_start = next.map(|(a, _)| a);
        let start = match self.start_hint.take() {
            Some((recorded, measured)) if recorded == item.start => measured,
            _ => item.start,
        };
        let s = start.max(self.frontier).max(0);
        if s + o.min_token > self.duration {
            self.warnings.push(format!("dropped an item at {}..{}: outside the source", item.start, item.end));
            return;
        }
        let mut e = item.end.min(self.duration);
        if let Some(n) = next_start
            && n > s
        {
            e = e.min(n);
        }
        if item.text.is_some() {
            if let Some(v) = item.vad_end
                && v > s + o.min_token
            {
                e = e.min(v + o.vad_end_slack);
            }
            e = levels.tighten_end(s, e, o.end_hangover, o.min_trim, o.min_token);
        }
        let e = e.max(s + o.min_token).min(self.duration);

        // Where a cut before this token lands.
        // Silence at the start of the source, up to where the sound before this item starts.
        let lead_in = if self.placed_any { 0 } else { levels.sound_onset_before(0, s, o.end_hangover, o.pause_min) };
        let cut_before = if let Some(c) = self.forced_cut.take().filter(|c| (self.frontier..=s).contains(c)) {
            c
        } else if !self.placed_any && lead_in > o.pause_min && self.on_grid_down(lead_in - o.pause_margin, 0) > 0 {
            // A leading pause chip.
            let p_end = self.on_grid_down(lead_in - o.pause_margin, 0);
            self.current.push(Token::Pause(PauseToken { start: 0, end: p_end, cut_before: 0 }));
            self.close_current();
            p_end
        } else {
            self.cut_in(self.frontier, s, levels)
        };

        let is_word = item.text.is_some();
        let token = match item.text {
            Some(text) => Token::Word(WordToken { start: s, end: e, cut_before, text }),
            None => {
                self.close_current();
                Token::Unrecognised(UnrecognisedToken { start: s, end: e, cut_before })
            }
        };
        self.current.push(token);
        self.frontier = e;
        self.placed_any = true;

        // The boundary after this token.
        let Some(next_start) = next_start else { return };
        let next_s = next_start.max(e).min(self.duration);
        let gap = next_s - e;
        // The silence ends where the sound before the next item starts, which can be earlier
        // than its first word (a soft "uh" the detector left out).
        let onset = if gap > o.pause_min { levels.sound_onset_before(e, next_s, o.end_hangover, o.pause_min) } else { next_s };
        if onset - e > o.pause_min {
            let p_start = self.on_grid_up(e + o.pause_margin, next_s);
            let p_end = self.on_grid_down(onset - o.pause_margin, p_start);
            if p_end > p_start {
                // A pause chip, tight against the speech with a margin on each side.
                self.current.push(Token::Pause(PauseToken { start: p_start, end: p_end, cut_before: p_start }));
                self.close_current();
                self.frontier = p_end;
                self.forced_cut = Some(p_end);
                return;
            }
        }
        // The cut point between this token and the next one.
        let next_end = next.map_or(next_s, |(_, b)| b);
        let c = self.boundary_cut(s, e, next_s, next_end, levels);
        if c < e {
            // The quiet starts before the recorded end: pull the end back to it.
            if let Some(last) = self.current.last_mut() {
                match last {
                    Token::Word(w) => w.end = c,
                    Token::Unrecognised(u) => u.end = c,
                    Token::Pause(p) => p.end = c,
                }
            }
            self.frontier = c;
        }
        if c > next_s {
            // The next word's recorded start sits in the quiet: push it forward.
            self.start_hint = Some((next_start, c));
        } else {
            // Its sound may start before its recorded start: pull it back to the onset.
            let onset = levels.sound_onset_before(c, next_s, o.end_hangover, next_s - c);
            if onset < next_s {
                self.start_hint = Some((next_start, onset));
            }
        }
        self.forced_cut = Some(c);
        let next_is_word = self.pending.first().is_some_and(|n| n.text.is_some());
        if !is_word || self.should_close_after(next_is_word, gap) {
            self.close_current();
        }
    }

    /// Whether the open utterance ends after its last word, given what follows it.
    fn should_close_after(&self, next_is_word: bool, gap: Micros) -> bool {
        let Some(last) = self.current.last() else { return false };
        let words = self.current.iter().filter(|t| matches!(t, Token::Word(_))).count();
        let first_start = self.current.first().map(Token::start).unwrap_or(0);
        let length = last.end() - first_start;
        match last {
            Token::Unrecognised(_) => return true,
            Token::Pause(_) => return true,
            Token::Word(w) => {
                if !next_is_word || ends_sentence(&w.text) {
                    return true;
                }
                if words >= self.opts.hard_max_words || length >= self.opts.hard_max_duration {
                    return true;
                }
                if (words >= self.opts.soft_max_words || length >= self.opts.soft_max_duration)
                    && (ends_clause(&w.text) || gap >= 300_000)
                {
                    return true;
                }
            }
        }
        false
    }

    fn close_current(&mut self) {
        if self.current.is_empty() {
            return;
        }
        let tokens = std::mem::take(&mut self.current);
        let start = tokens.first().map(Token::start).unwrap_or(0);
        let end = tokens.last().map(Token::end).unwrap_or(start);
        // Spec 3.4: `index` is the number Claude uses for the utterance, counted from 1.
        let index = self.finished.len() as u32 + 1;
        self.finished.push(Utterance { index, start, end, tokens });
    }

    /// The cut point between a token `[s, e)` and the next one, which starts at `next_s`
    /// (`>= e`) and ends at `next_end`. Normally the quietest point of the gap `[e, next_s]`.
    /// The model's word times are only as fine as its time resolution, so the true silence
    /// can lie a little before `e` or after `next_s`: the search also covers up to
    /// `boundary_reach` on each side (never leaving either token shorter than `min_token`),
    /// and takes the point found there when it is clearly quieter (6 dB) than the gap, quiet
    /// in itself (within 10 dB of the background), and has sound of each token on its own
    /// side (so a boundary never moves past a whole short word). Without sound levels, the
    /// gap's middle. Reads levels up to `next_s + 2 * boundary_reach` at most.
    fn boundary_cut(&self, s: Micros, e: Micros, next_s: Micros, next_end: Micros, levels: &LevelTrack) -> Micros {
        let o = &self.opts;
        let narrow = self.cut_in(e, next_s, levels);
        if o.boundary_reach <= 0 {
            return narrow;
        }
        let lo = (e - o.boundary_reach).max(s + o.min_token).min(e);
        let hi = (next_s + o.boundary_reach).min(next_end - o.min_token).min(self.duration - o.min_token).max(next_s);
        if lo >= e && hi <= next_s {
            return narrow;
        }
        let wide = self.cut_in(lo, hi, levels);
        if wide == narrow {
            return narrow;
        }
        // The level around a point, from audio inside the searched range only.
        let around = |c: Micros| levels.mean_level((c - 20_000).max(lo), (c + 20_000).min(hi));
        let floor = levels.noise_floor_before(lo);
        let clearly_quieter = matches!((around(narrow), around(wide)), (Some(ln), Some(lw)) if lw + 6.0 < ln && lw <= floor + 10.0);
        if !clearly_quieter {
            return narrow;
        }
        // Each token keeps sound of its own on its side of the cut, looking no further than
        // `boundary_reach` beyond the searched range.
        let loud = |a: Micros, b: Micros| levels.peak_level(a, b).is_some_and(|p| p >= floor + 10.0);
        let before = loud(s.max(lo - o.boundary_reach), wide.min(e));
        let after = loud(wide.max(next_s), next_end.min(hi + o.boundary_reach).min(self.duration));
        if before && after { wide } else { narrow }
    }

    /// The cut point for a gap `[a, b]`: its quietest point, on the frame grid if possible.
    fn cut_in(&self, a: Micros, b: Micros, levels: &LevelTrack) -> Micros {
        let c = levels.quietest_point(a, b);
        let Some(rate) = self.opts.cut_grid else { return c };
        [snap_to_frame(c, rate), floor_to_frame(c, rate), ceil_to_frame(c, rate)]
            .into_iter()
            .filter(|g| (a..=b).contains(g))
            .min_by_key(|g| (g - c).abs())
            .unwrap_or(c)
    }

    /// `t` moved up to the frame grid, if that stays below `limit`.
    fn on_grid_up(&self, t: Micros, limit: Micros) -> Micros {
        match self.opts.cut_grid {
            Some(rate) => {
                let g = ceil_to_frame(t, rate);
                if g < limit { g } else { t }
            }
            None => t,
        }
    }

    /// `t` moved down to the frame grid, if that stays above `limit`.
    fn on_grid_down(&self, t: Micros, limit: Micros) -> Micros {
        match self.opts.cut_grid {
            Some(rate) => {
                let g = floor_to_frame(t, rate);
                if g > limit { g } else { t }
            }
            None => t,
        }
    }
}

fn trailing_text(text: &str) -> &str {
    text.trim_end_matches(['"', '\'', '\u{201d}', '\u{2019}', ')', ']', '}'])
}

/// True for a word that ends a sentence (`.`, `?`, `!`, `…`).
fn ends_sentence(text: &str) -> bool {
    trailing_text(text).ends_with(['.', '?', '!', '\u{2026}'])
}

/// True for a word that ends a clause (`,`, `;`, `:`, a dash).
fn ends_clause(text: &str) -> bool {
    trailing_text(text).ends_with([',', ';', ':', '-', '\u{2013}', '\u{2014}'])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(text: &str, start: Micros, end: Micros) -> WordMsg {
        WordMsg { text: text.into(), start, end }
    }

    fn tokens(t: &Transcript) -> Vec<Token> {
        t.utterances.iter().flat_map(|u| u.tokens.clone()).collect()
    }

    #[test]
    fn splits_at_sentences_and_makes_pause_and_unrecognised_tokens() {
        let levels = LevelTrack::from_levels([]);
        let mut b = TranscriptBuilder::new("src", 20_000_000, BuildOptions::default());
        b.set_model("m");
        b.push_segment(1_000_000, 2_000_000, &[w("Hello", 1_000_000, 1_400_000), w("there.", 1_500_000, 1_900_000), w("Next", 1_950_000, 2_000_000)], &levels);
        // A 3 s gap, then speech without words, then a word.
        b.push_speech_without_words(5_000_000, 6_000_000, &levels);
        b.push_segment(6_200_000, 7_000_000, &[w("end", 6_300_000, 6_800_000)], &levels);
        b.finish(&[], &levels);
        let t = b.into_transcript();
        assert!(t.complete);
        assert_eq!(t.model, "m");
        let kinds: Vec<Vec<&str>> = t
            .utterances
            .iter()
            .map(|u| {
                u.tokens
                    .iter()
                    .map(|tok| match tok {
                        Token::Word(w) => w.text.as_str(),
                        Token::Pause(_) => "<pause>",
                        Token::Unrecognised(_) => "<?>",
                    })
                    .collect()
            })
            .collect();
        assert_eq!(
            kinds,
            vec![vec!["Hello", "there."], vec!["Next", "<pause>"], vec!["<?>"], vec!["end", "<pause>"]]
        );
        for (i, u) in t.utterances.iter().enumerate() {
            assert_eq!(u.index as usize, i + 1, "numbered from 1");
        }
        // The pause sits inside the gap with the margin on each side, and cutting it leaves the margins.
        let toks = tokens(&t);
        let Token::Pause(p) = &toks[3] else { panic!() };
        assert_eq!(p.start, 2_000_000 + 150_000);
        assert_eq!(p.end, 5_000_000 - 150_000);
        assert_eq!(p.cut_before, p.start);
        assert_eq!(toks[4].cut_before(), p.end);
        // The trailing pause reaches the end of the source.
        assert_eq!(toks.last().unwrap().end(), 20_000_000);
    }

    #[test]
    fn utterances_are_released_only_when_final() {
        let levels = LevelTrack::from_levels([]);
        let mut b = TranscriptBuilder::new("src", 10_000_000, BuildOptions::default());
        b.push_segment(0, 1_000_000, &[w("One.", 100_000, 500_000), w("Two", 600_000, 900_000)], &levels);
        // "One." is closed by "Two" starting a new sentence.
        let first = b.take_final_utterances();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].index, 1);
        assert!(b.take_final_utterances().is_empty());
        b.finish(&[], &levels);
        let rest = b.take_final_utterances();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].index, 2);
    }

    #[test]
    fn grid_puts_cut_points_on_frames() {
        let levels = LevelTrack::from_levels([]);
        let rate = Rational { num: 30, den: 1 };
        let opts = BuildOptions { cut_grid: Some(rate), ..BuildOptions::default() };
        let mut b = TranscriptBuilder::new("src", 30_000_000, opts);
        b.push_segment(0, 9_000_000, &[w("a", 500_000, 900_000), w("b", 1_000_000, 1_300_000), w("c", 4_000_000, 4_300_000)], &levels);
        b.finish(&[], &levels);
        for tok in tokens(&b.transcript()) {
            assert!(rc_types::is_on_frame_grid(tok.cut_before(), rate), "{tok:?}");
        }
    }

    /// Window levels: `-20` dB where `loud(i)` holds, digital silence elsewhere.
    fn track(n: usize, loud: impl Fn(usize) -> bool) -> LevelTrack {
        LevelTrack::from_levels((0..n).map(|i| if loud(i) { -20.0 } else { -100.0 }))
    }

    fn word_at<'a>(t: &'a Transcript, text: &str) -> &'a WordToken {
        t.utterances
            .iter()
            .flat_map(|u| &u.tokens)
            .find_map(|tok| match tok {
                Token::Word(w) if w.text == text => Some(w),
                _ => None,
            })
            .unwrap()
    }

    #[test]
    fn touching_words_are_cut_in_the_silence_inside_the_recorded_end() {
        // "page," sounds 0.5..1.0 s, silence until 1.3 s, "and" sounds 1.3..1.6 s. The model's
        // times touch at 1.45 s: the onset of "and" sits inside the recorded end of "page,".
        let levels = track(300, |i| (50..100).contains(&i) || (130..160).contains(&i));
        let mut b = TranscriptBuilder::new("src", 3_000_000, BuildOptions::default());
        b.push_segment(500_000, 1_600_000, &[w("page,", 500_000, 1_450_000), w("and", 1_450_000, 1_600_000)], &levels);
        b.finish(&[], &levels);
        let t = b.into_transcript();
        let (page, and) = (word_at(&t, "page,"), word_at(&t, "and"));
        assert_eq!(page.end, 1_040_000, "end pulled back to the sound plus the hangover");
        assert!((1_040_000..1_300_000).contains(&and.cut_before), "cut in the silence: {and:?}");
        assert!(and.start <= 1_300_000 && and.start >= and.cut_before, "start pulled back to the onset: {and:?}");
    }

    #[test]
    fn a_word_start_recorded_in_silence_is_pushed_forward() {
        // "a" sounds 0.5..0.95 s, silence to 1.0 s, "b" sounds from 1.0 s; the model says
        // "a" ends and "b" starts at 0.95 s, 50 ms too early, so the gap is only partly quiet.
        let levels = track(200, |i| (50..95).contains(&i) || (100..150).contains(&i));
        let mut b = TranscriptBuilder::new("src", 2_000_000, BuildOptions::default());
        b.push_segment(500_000, 1_500_000, &[w("a", 500_000, 900_000), w("b", 950_000, 1_500_000)], &levels);
        b.finish(&[], &levels);
        let t = b.into_transcript();
        let bw = word_at(&t, "b");
        assert!((950_000..=1_000_000).contains(&bw.cut_before), "{bw:?}");
        assert_eq!(levels.level((bw.cut_before / 10_000) as usize), Some(-100.0), "{bw:?}");
        assert!(bw.start >= bw.cut_before);
    }

    #[test]
    fn the_widened_search_never_jumps_past_a_short_word() {
        // "it." really sounds 1.0..1.08 s and is followed by silence; the model says it runs
        // 1.0..1.6 s. The silence after "it." must not become the cut before "it.".
        let levels = track(300, |i| (50..100).contains(&i) || (100..108).contains(&i) || (250..280).contains(&i));
        let mut b = TranscriptBuilder::new("src", 3_000_000, BuildOptions::default());
        b.push_segment(500_000, 1_600_000, &[w("much", 500_000, 1_000_000), w("it.", 1_000_000, 1_600_000)], &levels);
        b.push_segment(2_500_000, 2_800_000, &[w("Next", 2_500_000, 2_800_000)], &levels);
        b.finish(&[], &levels);
        let t = b.into_transcript();
        let it = word_at(&t, "it.");
        assert!(it.start <= 1_000_000, "{it:?}");
        assert!(it.end <= 1_200_000, "its end is still tightened: {it:?}");
    }

    #[test]
    fn done_ranges_nobody_reported_become_unrecognised() {
        let levels = LevelTrack::from_levels([]);
        let mut b = TranscriptBuilder::new("src", 10_000_000, BuildOptions::default());
        b.push_segment(0, 1_000_000, &[w("hi", 100_000, 500_000)], &levels);
        b.finish(&[RangeMsg { start: 0, end: 1_000_000 }, RangeMsg { start: 3_000_000, end: 4_000_000 }], &levels);
        let toks = tokens(&b.transcript());
        assert!(toks.iter().any(|t| matches!(t, Token::Unrecognised(u) if u.start == 3_000_000)));
    }
}
