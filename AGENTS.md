# VibeCab development

Agent-first personal task coordinator. Use Rust, Axum, SQLx, native PostgreSQL and
pgvector. No Docker, SQLite, or Python backend. The human interface is secondary.

Use this checkout; each cloud task is isolated. Do not create a worktree unless asked.
See README.md for the implemented API and explicit remaining work.

Run integration tests against a disposable PostgreSQL database with pgvector available.
Never silently skip database tests or replace them with mocks. Preserve atomic claims,
lease-token fencing, dependency gating, and capability-token privacy in listings.
Run cargo fmt --check, cargo test --locked, and cargo clippy --all-targets -- -D warnings.

## Cloud machine

The current prepared machine uses CARGO_HOME=/workspace/toolchains/cargo and
RUSTUP_HOME=/workspace/toolchains/rustup; prepend $CARGO_HOME/bin to PATH.
Native PostgreSQL runs on 127.0.0.1:55432. Use the `vibecab_test` database for API
tests and a separate `vibecab_ui` database for browser tests; user data is `vibecab`.
Browser test command: VCAB_TEST_URL=http://127.0.0.1:7433
CHROMIUM_PATH=/usr/bin/chromium npm run test:ui (with a test daemon already running).
Never mistake a running old binary for validation of newly embedded UI assets.

## Planning and UI invariants

All topology changes and task claims must lock the project before evaluating the
current graph. Validate proposed graphs atomically; preserve graph revisions and
stale-worker fencing. Task text changes invalidate embeddings. Include task versions
for edits from clients. Never place claim tokens in general responses or history.
Keep UI content escaped; no external runtime assets. Re-run the browser journey for
UI changes. See docs/ui-research.md and docs/api.json for interactions and API rules.
