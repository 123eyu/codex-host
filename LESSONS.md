# Lessons

Repository-specific invariants learned from real regressions and code reviews. Keep entries concrete, testable, and phrased as current rules. Remove an entry once enforced automatically by lint, schema, or CI.

## Compatibility & Contracts

- **Forward-compatible schemas for published clients**: When adding fields to persisted data or remote catalog entries read by older releases, check the last published tag (`git show <last-tag>:<path>`) and prefer `z.object(...)` over `z.strictObject(...)` unless strict rejection is explicitly required.
- **Guard non-semver version strings**: Version comparisons for extensions, catalogs, or releases must handle non-semver / malformed version strings safely instead of throwing or misclassifying upgrade state.
- **Verify hardcoded external artifact URLs and checksums live**: Before pinning release archive URLs or SHA-256 digests, fetch the live URL and verify the exact SHA-256 matches the published artifact.

## State & Lifecycle

- **Prune persisted references on entity deletion**: Deleting a session or Thread must remove its ID from persisted stores (such as workspace metadata), not only from in-memory caches or active registries.
- **Notify clients after slow on-demand snapshots**: When an on-demand snapshot/read path exceeds its synchronous wait window and falls back to cached or partial state, emit an asynchronous refresh notification once the read completes so Web clients do not stay stale.

## Platform & Workflows

- **Keep macOS-only test helpers compilable on Linux/Windows**: Guard cross-platform test utilities with `#[cfg(any(target_os = "macos", test))]` (or platform-neutral fakes) so `cargo test` and `clippy` pass on all CI runners.
- **Preserve `push` triggers on release-gating CI jobs**: When tightening PR CI workflows, never drop `github.event_name == 'push'` guards on core `check` jobs that validate `main` and release tags.
