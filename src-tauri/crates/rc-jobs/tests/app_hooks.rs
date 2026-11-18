//! What the app needs from the runner beyond the stand-in pipeline: the suggest port decides
//! how dead air and Claude's suggestions are merged, and sources whose cache was cleared are
//! forgotten (and rebuilt on the next import), never while they are busy.

mod standins;

use std::sync::Arc;

use rc_jobs::*;
use rc_types::*;
use standins::*;

/// Delegates to the stand-in, but merges by keeping only Claude's suggestions plus one marker,
/// so the test can tell the port's merge was used.
struct OwnMerge(Arc<Fakes>);

impl SuggestPort for OwnMerge {
    fn dead_air<'a>(
        &'a self,
        source: &'a SourceRef,
        transcript: &'a Transcript,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<Vec<Suggestion>, AppError>> {
        self.0.dead_air(source, transcript, cancel)
    }
    fn claude<'a>(
        &'a self,
        source: &'a SourceRef,
        transcript: &'a Transcript,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<ClaudeAnswer, AppError>> {
        self.0.claude(source, transcript, cancel)
    }
    fn merge(&self, dead_air: Vec<Suggestion>, claude: Vec<Suggestion>) -> Vec<Suggestion> {
        let source = dead_air.first().map(|s| s.range.source_id.clone()).unwrap_or_default();
        let mut out = claude;
        out.push(suggestion(&source, "merged", SuggestionKind::Aside, SuggestionOrigin::Local, 9_000_000));
        out
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_suggest_ports_merge_decides_the_final_set() {
    let fakes = Fakes::new();
    let sink = Arc::new(Collect::default());
    let ports = Ports { suggest: Arc::new(OwnMerge(fakes.clone())), ..fakes.ports() };
    let runner = JobRunner::new(
        RunnerConfig { media_base: BASE.into(), media_token: TOKEN.into(), limits: Limits::default() },
        ports,
        sink.clone(),
        tokio::runtime::Handle::current(),
    );
    runner.import("p", vec![input("a")]);
    idle(&runner).await;
    let sets: Vec<SuggestionSet> = sink
        .all()
        .into_iter()
        .filter_map(|e| match e {
            JobEvent::SuggestionsReady(s) => Some(s),
            _ => None,
        })
        .collect();
    assert_eq!(sets.len(), 2, "dead air, then the merged set");
    assert!(sets[0].claude_model.is_none());
    assert_eq!(sets[0].suggestions.len(), 1, "dead air alone first");
    let last = &sets[1];
    assert_eq!(last.claude_model.as_deref(), Some("opus-standin"));
    let kinds: Vec<SuggestionKind> = last.suggestions.iter().map(|s| s.kind).collect();
    assert_eq!(kinds, vec![SuggestionKind::Retake, SuggestionKind::Aside], "the port's merge, not a concatenation");
    assert_eq!(fakes.suggestions.lock().unwrap()["a"], *last, "the merged set is what is cached");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_default_merge_keeps_both_in_time_order() {
    let fakes = Fakes::new();
    let (runner, sink) = new_runner(&fakes);
    runner.import("p", vec![input("a")]);
    idle(&runner).await;
    let last = sink
        .all()
        .into_iter()
        .filter_map(|e| match e {
            JobEvent::SuggestionsReady(s) => Some(s),
            _ => None,
        })
        .last()
        .unwrap();
    let starts: Vec<Micros> = last.suggestions.iter().map(|s| s.range.start).collect();
    assert_eq!(starts, vec![1_000_000, 2_000_000]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cleared_sources_are_forgotten_and_rebuilt_but_never_while_busy() {
    let fakes = Fakes::new();
    fakes.knobs.step_ms.store(20, std::sync::atomic::Ordering::SeqCst);
    let (runner, _sink) = new_runner(&fakes);
    runner.import("p", vec![input("a")]);
    // While its jobs run, the source is busy and cannot be forgotten.
    assert_eq!(runner.busy_sources(), vec!["a".to_string()]);
    assert!(runner.forget_sources(&["a".to_string()]).is_empty());
    assert!(runner.assets("a").is_some());
    idle(&runner).await;
    assert!(runner.busy_sources().is_empty());
    assert_eq!(runner.assets("a").unwrap().playback, PlaybackSource::Proxy);
    assert_eq!(fakes.calls("proxy:a"), 1);

    // The cache was cleared (as clear_cache does): the files are gone.
    fakes.ready.lock().unwrap().clear();
    assert_eq!(runner.forget_sources(&["a".to_string(), "unknown".to_string()]), vec!["a".to_string()]);
    assert!(runner.assets("a").is_none());

    // The next import looks at the cache again and rebuilds the proxy and waveform.
    let assets = runner.import("p", vec![input("a")]);
    assert_eq!(assets[0].playback, PlaybackSource::Original, "no stale 'proxy ready'");
    idle(&runner).await;
    assert_eq!(fakes.calls("proxy:a"), 2);
    assert_eq!(fakes.calls("waveform:a"), 2);
    assert_eq!(runner.assets("a").unwrap().playback, PlaybackSource::Proxy);
}
