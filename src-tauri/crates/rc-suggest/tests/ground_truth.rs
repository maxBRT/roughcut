//! The recorded answers of milestone 0, read and mapped by this crate, scored against the
//! experiment's planted ground truth (as spikes/claude/score.py did, but on mapped source
//! ranges): every quote is located, every planted item is found with the right kind, no
//! suggestion falls outside the planted items, and retakes point at the planted take to keep.

mod common;

use common::{envelope, transcript};
use rc_suggest::{ClaudeKind, ClaudeSuggestion, map_suggestions, read_answer};
use rc_types::{Micros, Suggestion, SuggestionKind};
use serde_json::Value;

fn truth(name: &str) -> Vec<ClaudeSuggestion> {
    let v: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(common::data(name)).unwrap()).unwrap();
    v.into_iter()
        .map(|g| ClaudeSuggestion {
            kind: serde_json::from_value(g["kind"].clone()).unwrap(),
            first_utterance: g["first_utterance"].as_u64().unwrap() as u32,
            last_utterance: g["last_utterance"].as_u64().unwrap() as u32,
            quote: g["quote"].as_str().unwrap().into(),
            reason: "planted".into(),
            keep_utterance: g
                .get("keep_utterance")
                .and_then(Value::as_u64)
                .map(|k| k as u32),
        })
        .collect()
}

fn overlap(a: &Suggestion, b: &Suggestion) -> Micros {
    (a.range.end.min(b.range.end) - a.range.start.max(b.range.start)).max(0)
}

fn score(recorded: &str, transcript_name: &str, truth_name: &str, planted: usize) {
    let tr = transcript(transcript_name);
    let env = envelope(recorded);
    let answer = read_answer(Some(0), &env.to_string(), "").unwrap();
    let mapped = map_suggestions(&tr, &answer.suggestions, None);
    assert_eq!(
        mapped.len(),
        answer.suggestions.len(),
        "{recorded}: every quote is located"
    );

    let gt_raw = truth(truth_name);
    let gt = map_suggestions(&tr, &gt_raw, None);
    assert_eq!(
        gt.len(),
        planted,
        "{truth_name}: every planted quote is located"
    );

    let mut ious = Vec::new();
    let mut exact = 0;
    let mut keep_ok = 0;
    let mut keep_total = 0;
    for (g, raw) in gt.iter().zip(&gt_raw) {
        let m = mapped
            .iter()
            .filter(|m| overlap(m, g) > 0)
            .max_by_key(|m| overlap(m, g))
            .unwrap_or_else(|| panic!("{recorded}: missed planted {:?} {:?}", raw.kind, raw.quote));
        assert_eq!(m.kind, g.kind, "{recorded}: kind of {:?}", raw.quote);
        let union = m.range.end.max(g.range.end) - m.range.start.min(g.range.start);
        let iou = overlap(m, g) as f64 / union as f64;
        if m.range == g.range {
            exact += 1;
        }
        ious.push(iou);
        if raw.kind == ClaudeKind::Retake {
            keep_total += 1;
            let want = rc_suggest::utterance_by_number(&tr, raw.keep_utterance.unwrap())
                .unwrap()
                .start;
            if m.kept_version_at == Some(want) {
                keep_ok += 1;
            }
        }
    }
    for m in &mapped {
        assert!(
            gt.iter().any(|g| overlap(m, g) > 0),
            "{recorded}: suggestion outside the planted items: {}",
            m.reason
        );
        if m.kind == SuggestionKind::Retake {
            assert!(m.kept_version_at.unwrap() >= m.range.end);
        }
    }
    let mean = ious.iter().sum::<f64>() / ious.len() as f64;
    println!(
        "{recorded}: {} suggestions, planted found {}/{}, exact extent {exact}, mean IoU {mean:.3}, retake keep correct {keep_ok}/{keep_total}",
        mapped.len(),
        gt.len(),
        planted
    );
    assert!(mean >= 0.95, "{recorded}: mean IoU {mean}");
    assert_eq!(
        keep_ok, keep_total,
        "{recorded}: kept version of every retake"
    );
}

#[test]
fn success_150() {
    score(
        "recorded/success-150.stdout.txt",
        "transcript-150.json",
        "ground-truth-150.json",
        21,
    );
}

#[test]
fn success_150_v1_verbose() {
    score(
        "recorded/success-150-v1-verbose.stdout.txt",
        "transcript-150.json",
        "ground-truth-150.json",
        21,
    );
}

#[test]
fn success_600_v1() {
    score(
        "recorded/success-600-v1.stdout.txt",
        "transcript-600.json",
        "ground-truth-600.json",
        84,
    );
}

#[test]
fn success_600_v2_verbose() {
    score(
        "recorded/success-600-v2-verbose.stdout.txt",
        "transcript-600.json",
        "ground-truth-600.json",
        84,
    );
}

#[test]
fn success_600_v2_effort_low() {
    score(
        "recorded/success-600-v2-effort-low.stdout.txt",
        "transcript-600.json",
        "ground-truth-600.json",
        84,
    );
}

#[test]
fn a_misquoted_suggestion_is_dropped_and_the_rest_kept() {
    let tr = transcript("transcript-150.json");
    let env = envelope("recorded/success-150.stdout.txt");
    let mut answer = read_answer(Some(0), &env.to_string(), "")
        .unwrap()
        .suggestions;
    answer[0].quote.push_str(" words nobody said");
    answer[1].first_utterance += 40;
    answer[1].last_utterance += 40;
    let mapped = map_suggestions(&tr, &answer, None);
    assert_eq!(mapped.len(), answer.len() - 2);
}
