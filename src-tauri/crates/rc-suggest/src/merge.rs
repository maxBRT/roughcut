//! Combining dead air with Claude's suggestions into one non-overlapping list.
//!
//! Rules:
//! 1. Claude's suggestions, in time order: one that overlaps an earlier kept one is dropped
//!    (the prompt asks for no overlaps; this only catches a mistake).
//! 2. Dead air never overlaps a Claude suggestion: the part of the silence a Claude
//!    suggestion already cuts is taken out. What remains is kept only when it is at least
//!    [`MIN_TRIMMED_DEAD_AIR`] long (the longest remaining piece, when a Claude cut falls in
//!    the middle of the silence); otherwise the dead air is dropped, because accepting the
//!    Claude suggestion already removes most of that silence.
//! 3. The result is sorted by start time; ids are recomputed for trimmed ranges, so every id
//!    still derives from its source and range.

use rc_types::{Micros, Suggestion, SuggestionOrigin};

use crate::mapping::suggestion_id;

/// The shortest piece of dead air kept after trimming around a Claude suggestion: 1 s.
pub const MIN_TRIMMED_DEAD_AIR: Micros = 1_000_000;

fn overlaps(a: &Suggestion, b: &Suggestion) -> bool {
    a.range.source_id == b.range.source_id
        && a.range.start < b.range.end
        && b.range.start < a.range.end
}

/// Merges locally found dead air with Claude's mapped suggestions (see the module rules).
pub fn merge_suggestions(dead_air: Vec<Suggestion>, claude: Vec<Suggestion>) -> Vec<Suggestion> {
    let mut claude = claude;
    claude.sort_by_key(|s| (s.range.start, s.range.end));
    let mut kept_claude: Vec<Suggestion> = Vec::with_capacity(claude.len());
    for s in claude {
        if !kept_claude.iter().any(|k| overlaps(k, &s)) {
            kept_claude.push(s);
        }
    }

    let mut out: Vec<Suggestion> = Vec::with_capacity(dead_air.len() + kept_claude.len());
    for d in dead_air {
        // The pieces of the silence that no Claude suggestion covers.
        let mut pieces = vec![(d.range.start, d.range.end)];
        for c in kept_claude
            .iter()
            .filter(|c| c.range.source_id == d.range.source_id)
        {
            pieces = pieces
                .into_iter()
                .flat_map(|(s, e)| {
                    if c.range.end <= s || c.range.start >= e {
                        vec![(s, e)]
                    } else {
                        let mut v = Vec::new();
                        if c.range.start > s {
                            v.push((s, c.range.start));
                        }
                        if c.range.end < e {
                            v.push((c.range.end, e));
                        }
                        v
                    }
                })
                .collect();
        }
        let untouched = pieces.len() == 1 && pieces[0] == (d.range.start, d.range.end);
        if untouched {
            out.push(d);
            continue;
        }
        if let Some(&(s, e)) = pieces.iter().max_by_key(|(s, e)| (e - s, -s))
            && e - s >= MIN_TRIMMED_DEAD_AIR
        {
            let mut t = d.clone();
            t.range.start = s;
            t.range.end = e;
            t.id = suggestion_id(&t.range);
            out.push(t);
        }
    }
    out.extend(kept_claude);
    // Dead air first when two start together (cannot overlap after the rules above).
    out.sort_by_key(|s| (s.range.start, s.origin == SuggestionOrigin::Claude));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use rc_types::{SourceRange, SuggestionKind};

    fn s(kind: SuggestionKind, start: Micros, end: Micros) -> Suggestion {
        let range = SourceRange {
            source_id: "src".into(),
            start,
            end,
        };
        Suggestion {
            id: suggestion_id(&range),
            kind,
            origin: if kind == SuggestionKind::DeadAir {
                SuggestionOrigin::Local
            } else {
                SuggestionOrigin::Claude
            },
            range,
            reason: "r".into(),
            kept_version_at: None,
        }
    }

    fn ranges(v: &[Suggestion]) -> Vec<(Micros, Micros)> {
        v.iter().map(|s| (s.range.start, s.range.end)).collect()
    }

    #[test]
    fn disjoint_suggestions_are_all_kept_in_time_order() {
        let m = merge_suggestions(
            vec![s(SuggestionKind::DeadAir, 10, 20_000_000)],
            vec![
                s(SuggestionKind::Retake, 30_000_000, 40_000_000),
                s(SuggestionKind::Aside, 0, 5),
            ],
        );
        assert_eq!(
            ranges(&m),
            vec![(0, 5), (10, 20_000_000), (30_000_000, 40_000_000)]
        );
    }

    #[test]
    fn dead_air_inside_a_claude_cut_is_dropped() {
        let m = merge_suggestions(
            vec![s(SuggestionKind::DeadAir, 2_000_000, 5_000_000)],
            vec![s(SuggestionKind::Retake, 0, 10_000_000)],
        );
        assert_eq!(ranges(&m), vec![(0, 10_000_000)]);
        assert_eq!(m[0].kind, SuggestionKind::Retake);
    }

    #[test]
    fn dead_air_partly_covered_is_trimmed_and_gets_a_new_id() {
        let d = s(SuggestionKind::DeadAir, 2_000_000, 6_000_000);
        let old_id = d.id.clone();
        let m = merge_suggestions(vec![d], vec![s(SuggestionKind::FalseStart, 0, 3_000_000)]);
        assert_eq!(ranges(&m), vec![(0, 3_000_000), (3_000_000, 6_000_000)]);
        assert_eq!(m[1].kind, SuggestionKind::DeadAir);
        assert_ne!(m[1].id, old_id);
        assert_eq!(m[1].id, suggestion_id(&m[1].range));
    }

    #[test]
    fn short_remainder_is_dropped_and_middle_cut_keeps_the_longer_side() {
        let m = merge_suggestions(
            vec![s(SuggestionKind::DeadAir, 2_000_000, 3_500_000)],
            vec![s(SuggestionKind::Aside, 0, 2_800_000)],
        );
        assert_eq!(ranges(&m), vec![(0, 2_800_000)]);
        let m = merge_suggestions(
            vec![s(SuggestionKind::DeadAir, 0, 10_000_000)],
            vec![s(SuggestionKind::Aside, 3_000_000, 4_000_000)],
        );
        assert_eq!(
            ranges(&m),
            vec![(3_000_000, 4_000_000), (4_000_000, 10_000_000)]
        );
    }

    #[test]
    fn overlapping_claude_suggestions_keep_the_earlier() {
        let m = merge_suggestions(
            vec![],
            vec![
                s(SuggestionKind::Aside, 5, 15),
                s(SuggestionKind::Retake, 0, 10),
                s(SuggestionKind::FalseStart, 10, 12),
            ],
        );
        assert_eq!(ranges(&m), vec![(0, 10), (10, 12)]);
    }
}
