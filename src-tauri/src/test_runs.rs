//! Cancellation for batch source tests.
//!
//! **Why the backend has to be involved at all.** The frontend can stop *waiting* for a test on its
//! own, and it already did — the worker pool races each request against a cancellation signal. But
//! the requests themselves live in Rust, so abandoning the wait left them running to their own
//! 15 s (reqwest) / 25 s (outer) bound. Measured on the user's report ("我明明点击了取消测速，但是它
//! 还在后台测，根本没有立刻停下来"): the batch summary said 已取消 while sixteen sockets were still
//! open, and — because each result was still persisted on arrival — the source list kept mutating
//! after the run was declared over.
//!
//! A flag cannot interrupt a request that is already awaiting; the future has to be **dropped**, which
//! is what actually closes the connection. So the test commands race their work against this flag
//! with `tokio::select!`, and dropping the losing branch is the cancellation.
//!
//! Keyed by a run id the frontend generates, for the same reason `MediaStreamRegistry` is: only the
//! frontend knows which run a request belongs to, and a batch that is restarted must not be
//! cancelled by the previous run's signal.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How often a waiting test re-reads its cancellation flag.
///
/// The flag is an `AtomicBool`, not a channel, so this is a poll rather than a wake-up. 50 ms is
/// chosen against what the user perceives: a cancel that lands within one frame's worth of time
/// reads as immediate, and the cost is one atomic load per waiting test per 50 ms — nothing beside
/// the network wait it sits next to.
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Default)]
pub struct TestRunRegistry(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl TestRunRegistry {
    /// The flag for a run, created on first use.
    ///
    /// Created rather than looked up because the frontend registers nothing up front: a test that
    /// arrives before any cancel has to have something to poll, or a cancel issued a moment later
    /// would find no flag and be silently ignored.
    pub fn flag_for(&self, run_id: &str) -> Arc<AtomicBool> {
        let mut runs = match self.0.lock() {
            Ok(runs) => runs,
            // A poisoned lock means another thread panicked while holding it. The registry is a set
            // of booleans, so recovering the map is safe and beats propagating the panic into a
            // command the user is waiting on.
            Err(poisoned) => poisoned.into_inner(),
        };
        runs.entry(run_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    /// Marks a run cancelled, and reports whether it was known.
    ///
    /// An unknown id still gets a flag, because a cancel can legitimately arrive before the first
    /// request of that run has been registered.
    pub fn cancel(&self, run_id: &str) {
        self.flag_for(run_id).store(true, Ordering::SeqCst);
    }

    /// Forgets a run once it is over, so the map cannot grow for the process's lifetime.
    pub fn forget(&self, run_id: &str) {
        let mut runs = match self.0.lock() {
            Ok(runs) => runs,
            Err(poisoned) => poisoned.into_inner(),
        };
        runs.remove(run_id);
    }
}

/// Resolves once the run has been cancelled.
///
/// Used as the losing branch of a `select!`: when this wins, the test's own future is dropped, which
/// is what closes the socket. Never returns on its own — a test that finishes first takes the other
/// branch, and this is dropped with it.
pub async fn wait_for_cancellation(flag: Arc<AtomicBool>) {
    loop {
        if flag.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(CANCEL_POLL_INTERVAL).await;
    }
}

/// Cancels a batch test run.
///
/// Idempotent, and deliberately tolerant of an unknown id: the frontend cannot know whether a run
/// has already finished, and reporting that as an error would turn an ordinary outcome into a
/// message the user has to interpret.
#[tauri::command]
pub fn cancel_source_test(
    run_id: String,
    registry: tauri::State<'_, TestRunRegistry>,
) -> Result<(), String> {
    registry.cancel(&run_id);
    Ok(())
}

/// Drops a finished run's flag.
///
/// Called by the frontend when a batch ends, so a long session of many batches does not accumulate
/// one entry per run. Failure is not reported: a leftover flag costs a few bytes and is harmless.
#[tauri::command]
pub fn forget_source_test_run(
    run_id: String,
    registry: tauri::State<'_, TestRunRegistry>,
) -> Result<(), String> {
    registry.forget(&run_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flag_starts_uncancelled_and_is_shared_per_run() {
        let registry = TestRunRegistry::default();
        let first = registry.flag_for("run-1");
        let second = registry.flag_for("run-1");

        assert!(!first.load(Ordering::SeqCst));
        // The same run must share one flag, or a cancel would only reach whichever handle it found.
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn cancelling_one_run_does_not_cancel_another() {
        // The case that matters: a second batch started after a cancelled one must not be born
        // cancelled, which is what a single global flag would have done.
        let registry = TestRunRegistry::default();
        let cancelled = registry.flag_for("run-1");
        let fresh = registry.flag_for("run-2");

        registry.cancel("run-1");

        assert!(cancelled.load(Ordering::SeqCst));
        assert!(!fresh.load(Ordering::SeqCst));
    }

    #[test]
    fn cancelling_an_unknown_run_still_arms_its_flag() {
        // A cancel can arrive before the first request of that run registers itself. Ignoring it
        // would mean the run proceeds un-cancellable, which is the bug this exists to fix.
        let registry = TestRunRegistry::default();
        registry.cancel("never-seen");

        assert!(registry.flag_for("never-seen").load(Ordering::SeqCst));
    }

    #[test]
    fn forgetting_a_run_releases_its_flag() {
        let registry = TestRunRegistry::default();
        registry.cancel("run-1");
        registry.forget("run-1");

        // A forgotten run is a new run: its flag is fresh, not the cancelled one.
        assert!(!registry.flag_for("run-1").load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_cancelled_flag_resolves_the_wait() {
        let registry = TestRunRegistry::default();
        let flag = registry.flag_for("run-1");
        let waiter = tokio::spawn(wait_for_cancellation(flag.clone()));

        registry.cancel("run-1");

        // Bounded so a broken implementation fails the test instead of hanging the suite.
        tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("the wait must resolve once the run is cancelled")
            .expect("the wait must not panic");
    }
}
