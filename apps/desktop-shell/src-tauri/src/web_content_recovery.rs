#![cfg_attr(not(any(target_os = "macos", target_os = "ios")), allow(dead_code))]

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use url::Url;

use crate::navigation::{Navigation, classify};
use crate::{Page, Status};

pub(crate) const CRASH_LOOP_WINDOW: Duration = Duration::from_secs(60);
pub(crate) const MAX_AUTO_RECOVERIES_IN_WINDOW: usize = 3;
pub(crate) const CRASH_LOOP_ERROR_MESSAGE: &str =
    "The WebView renderer process terminated repeatedly. Click Retry to reload.";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RecoveryAction {
    Ignore,
    ReloadCurrentWeb,
    NavigateWebLogin(Url),
    RestartWeb,
    ReloadLoading(Status),
    ReloadOnboarding,
    TripCircuitBreaker(String),
}

#[derive(Default)]
pub(crate) struct WebContentRecovery {
    recent_terminations: VecDeque<Instant>,
    circuit_tripped: bool,
}

impl WebContentRecovery {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Reset crash history and clear the circuit breaker (e.g. after explicit user retry).
    pub(crate) fn reset(&mut self) {
        self.recent_terminations.clear();
        self.circuit_tripped = false;
    }

    /// Clear only the tripped flag when the Web UI reconnects without erasing the recent crash window.
    pub(crate) fn clear_tripped(&mut self) {
        self.circuit_tripped = false;
    }

    pub(crate) fn decide(
        &mut self,
        page: &Page,
        last_login: Option<&Url>,
        current_url: Option<&Url>,
        now: Instant,
    ) -> RecoveryAction {
        if matches!(page, Page::Dormant) {
            return RecoveryAction::Ignore;
        }
        if self.circuit_tripped {
            return RecoveryAction::Ignore;
        }

        while let Some(&oldest) = self.recent_terminations.front() {
            if now.saturating_duration_since(oldest) >= CRASH_LOOP_WINDOW {
                self.recent_terminations.pop_front();
            } else {
                break;
            }
        }

        if self.recent_terminations.len() >= MAX_AUTO_RECOVERIES_IN_WINDOW {
            self.circuit_tripped = true;
            return RecoveryAction::TripCircuitBreaker(CRASH_LOOP_ERROR_MESSAGE.to_owned());
        }

        self.recent_terminations.push_back(now);

        match page {
            Page::Dormant => RecoveryAction::Ignore,
            Page::Web => {
                if current_url.is_some_and(|url| classify(url, last_login) == Navigation::Web) {
                    RecoveryAction::ReloadCurrentWeb
                } else if let Some(login) = last_login {
                    RecoveryAction::NavigateWebLogin(login.clone())
                } else {
                    RecoveryAction::RestartWeb
                }
            }
            Page::Loading(status, _) => RecoveryAction::ReloadLoading(*status),
            Page::Onboarding => RecoveryAction::ReloadOnboarding,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login_url() -> Url {
        Url::parse("http://127.0.0.1:4400/?token=secret").unwrap()
    }

    #[test]
    fn recovers_single_termination_across_active_pages_and_respects_origin() {
        let mut recovery = WebContentRecovery::new();
        let login = login_url();
        let live_session = Url::parse("http://127.0.0.1:4400/?session=abc").unwrap();
        let blank = Url::parse("about:blank").unwrap();
        let untrusted = Url::parse("https://example.com/").unwrap();
        let start = Instant::now();

        assert_eq!(
            recovery.decide(&Page::Web, Some(&login), Some(&live_session), start),
            RecoveryAction::ReloadCurrentWeb
        );
        assert_eq!(
            recovery.decide(
                &Page::Web,
                Some(&login),
                Some(&blank),
                start + Duration::from_secs(1)
            ),
            RecoveryAction::NavigateWebLogin(login.clone())
        );
        assert_eq!(
            recovery.decide(
                &Page::Web,
                Some(&login),
                Some(&untrusted),
                start + Duration::from_secs(2)
            ),
            RecoveryAction::NavigateWebLogin(login.clone())
        );

        let mut fresh = WebContentRecovery::new();
        assert_eq!(
            fresh.decide(&Page::Web, None, None, start),
            RecoveryAction::RestartWeb
        );
        assert_eq!(
            fresh.decide(
                &Page::Loading(Status::Reconnecting, None),
                Some(&login),
                None,
                start + Duration::from_secs(1)
            ),
            RecoveryAction::ReloadLoading(Status::Reconnecting)
        );
        assert_eq!(
            fresh.decide(
                &Page::Onboarding,
                None,
                None,
                start + Duration::from_secs(2)
            ),
            RecoveryAction::ReloadOnboarding
        );
    }

    #[test]
    fn trips_circuit_breaker_on_rapid_crash_loop_and_resets_after_retry() {
        let mut recovery = WebContentRecovery::new();
        let login = login_url();
        let live_session = Url::parse("http://127.0.0.1:4400/?session=abc").unwrap();
        let start = Instant::now();

        for i in 0..MAX_AUTO_RECOVERIES_IN_WINDOW {
            assert_eq!(
                recovery.decide(
                    &Page::Web,
                    Some(&login),
                    Some(&live_session),
                    start + Duration::from_secs(i as u64),
                ),
                RecoveryAction::ReloadCurrentWeb
            );
        }

        assert_eq!(
            recovery.decide(
                &Page::Web,
                Some(&login),
                Some(&live_session),
                start + Duration::from_secs(10),
            ),
            RecoveryAction::TripCircuitBreaker(CRASH_LOOP_ERROR_MESSAGE.to_owned())
        );

        // Repeated terminations while tripped (e.g. error page itself crashes) are ignored.
        assert_eq!(
            recovery.decide(
                &Page::Loading(Status::Error, Some(CRASH_LOOP_ERROR_MESSAGE.into())),
                Some(&login),
                None,
                start + Duration::from_secs(11),
            ),
            RecoveryAction::Ignore
        );

        // Explicit manual retry resets the breaker and allows auto-recovery again.
        recovery.reset();
        assert_eq!(
            recovery.decide(
                &Page::Web,
                Some(&login),
                Some(&live_session),
                start + Duration::from_secs(12),
            ),
            RecoveryAction::ReloadCurrentWeb
        );
    }

    #[test]
    fn allows_auto_recovery_again_after_sliding_window_expires() {
        let mut recovery = WebContentRecovery::new();
        let login = login_url();
        let live_session = Url::parse("http://127.0.0.1:4400/?session=abc").unwrap();
        let start = Instant::now();

        for i in 0..MAX_AUTO_RECOVERIES_IN_WINDOW {
            assert_eq!(
                recovery.decide(
                    &Page::Web,
                    Some(&login),
                    Some(&live_session),
                    start + Duration::from_secs(i as u64),
                ),
                RecoveryAction::ReloadCurrentWeb
            );
        }

        let after_window = start + CRASH_LOOP_WINDOW + Duration::from_secs(1);
        assert_eq!(
            recovery.decide(&Page::Web, Some(&login), Some(&live_session), after_window),
            RecoveryAction::ReloadCurrentWeb
        );
    }

    #[test]
    fn dormant_page_is_ignored_without_consuming_crash_budget() {
        let mut recovery = WebContentRecovery::new();
        let login = login_url();
        let live_session = Url::parse("http://127.0.0.1:4400/?session=abc").unwrap();
        let start = Instant::now();

        for i in 0..(MAX_AUTO_RECOVERIES_IN_WINDOW + 2) {
            assert_eq!(
                recovery.decide(
                    &Page::Dormant,
                    Some(&login),
                    Some(&live_session),
                    start + Duration::from_secs(i as u64),
                ),
                RecoveryAction::Ignore
            );
        }

        // Switching back to active Web page still has full auto-recovery budget.
        assert_eq!(
            recovery.decide(
                &Page::Web,
                Some(&login),
                Some(&live_session),
                start + Duration::from_secs(10),
            ),
            RecoveryAction::ReloadCurrentWeb
        );
    }

    #[test]
    fn clear_tripped_preserves_recent_crash_window_until_expiry() {
        let mut recovery = WebContentRecovery::new();
        let login = login_url();
        let live_session = Url::parse("http://127.0.0.1:4400/?session=abc").unwrap();
        let start = Instant::now();

        for i in 0..MAX_AUTO_RECOVERIES_IN_WINDOW {
            assert_eq!(
                recovery.decide(
                    &Page::Web,
                    Some(&login),
                    Some(&live_session),
                    start + Duration::from_secs(i as u64),
                ),
                RecoveryAction::ReloadCurrentWeb
            );
        }
        assert_eq!(
            recovery.decide(
                &Page::Web,
                Some(&login),
                Some(&live_session),
                start + Duration::from_secs(10),
            ),
            RecoveryAction::TripCircuitBreaker(CRASH_LOOP_ERROR_MESSAGE.to_owned())
        );

        // Reconnect clears tripped state, but crashes still within the window re-trip immediately.
        recovery.clear_tripped();
        assert_eq!(
            recovery.decide(
                &Page::Web,
                Some(&login),
                Some(&live_session),
                start + Duration::from_secs(11),
            ),
            RecoveryAction::TripCircuitBreaker(CRASH_LOOP_ERROR_MESSAGE.to_owned())
        );

        // Once the window expires after clear_tripped, auto-recovery works again.
        recovery.clear_tripped();
        assert_eq!(
            recovery.decide(
                &Page::Web,
                Some(&login),
                Some(&live_session),
                start + CRASH_LOOP_WINDOW + Duration::from_secs(1),
            ),
            RecoveryAction::ReloadCurrentWeb
        );
    }
}
