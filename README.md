# VibeCab

A local, agent-first project workspace. Capture ideas, connect prerequisites, and let
multiple agents claim independent work safely. Rust + Axum + SQLx, native PostgreSQL
18, and pgvector. No Docker or Python backend.

The Rust executable serves both the JSON API and the bundled web interface. There
is no frontend development server or runtime dependency on Node.js.

## Run locally

Install the Rust toolchain specified in `rust-toolchain.toml`, native PostgreSQL 18,
and pgvector 0.8 or newer. Start PostgreSQL using your operating system's service
manager. Create a UTF-8 database owned by your local database role:

```sh
createdb vibecab
export DATABASE_URL=postgresql://localhost/vibecab
cargo run --locked
```

The server binds to `127.0.0.1:7432`; `VCAB_PORT` changes the port. Open that local
address in your laptop's browser. SQLx applies migrations on startup. The database
role must be able to create the `vector` extension, or an administrator must enable
it first. Connection credentials belong in the process environment, not source files.
The API assumes a trusted local machine and does not implement user authentication.

## Agent workflow

`GET /api` returns a machine-readable endpoint guide, request examples, and rules.
The same guide is checked into [docs/api.json](docs/api.json).

1. Create a project and capture tasks. `POST /projects/{id}/capture` accepts up to
   200 tasks with aliases and dependencies in one atomic request. A `request_id`
   makes identical retries safe; changed content with the same ID is rejected.
2. Inspect `GET /projects/{id}/graph`. It includes task context, edge rationale,
   direct blockers, transitive ancestors/dependents, downstream impact, and
   prerequisite-first execution layers. `GET /tasks/{id}/dependencies` returns a
   focused view of a task and its related context.
3. Send a proposed plan to `PUT /projects/{id}/dependencies` with the graph's
   `expected_revision` and `dry_run: true`. Apply the same plan with false after
   evaluating the preview. Each change replaces that task's prerequisites.
4. Claim a specific task, or call `POST /projects/{id}/claim-next` to atomically
   select and claim the highest-priority eligible task. An empty queue returns
   `{"task":null}`. Priority is 0 urgent, 1 high, 2 normal, 3 low.
5. Retain the returned `claim_token`. Renew before expiration, then complete or
   release with that token and result/handoff notes. Lease durations are 1–3600
   seconds; the default is five minutes.

Example dependency plan (UUID placeholders must be replaced):

```json
{
  "expected_revision": 4,
  "dry_run": true,
  "changes": [
    {
      "task_id": "dependent-task-uuid",
      "dependencies": ["prerequisite-task-uuid"],
      "rationale": "Agree on the API contract before implementing the client."
    }
  ]
}
```

Edges mean **task_id depends on depends_on**. Cycles, self-dependencies, cross-project
edges, stale graph revisions, and dependency edits to claimed/completed tasks are
rejected. Multiple edits either all apply or none do. Project row locks serialize
claims and graph changes; eligibility is read after acquiring the lock.

Execution layers describe structural order, not current eligibility. BACKLOG ideas
are not executable. TODO tasks and expired claims are eligible only when every
prerequisite is DONE. CANCELED prerequisites still block dependents. DONE is terminal.

Claim tokens appear only in successful claim responses, never in task listings,
graphs, search, or history. An expired token cannot renew, complete, or release work.
A task claim does not isolate repository files: agents must still coordinate edits
or use their own explicitly chosen isolation strategy.

## Tasks and history

Create, list, fetch, edit, and delete tasks through the API. Edits accept title,
description, priority, and BACKLOG/TODO/CANCELED status. Include `expected_version`
to reject concurrent stale edits; legacy clients may omit it for last-write-wins.
The web UI always sends a version. Claimed and completed tasks cannot be edited.
A prerequisite with dependents cannot be deleted. Canceling preserves its context.

`GET /tasks/{id}/history` returns the most recent 100 events, including dependency
rationale and agent status transitions. Heartbeat-only renewals do not flood history.
Events survive task deletion. History is a local activity log, not an authenticated
audit trail.

## Semantic search

Use your preferred embedding provider locally or externally:

- `PUT /tasks/{id}/embedding` accepts `model`, `embedding`, and `expected_version`.
- `POST /projects/{id}/search` accepts `model`, query `embedding`, and `limit`.

Search returns cosine distance, lowest first, restricted to the same project,
model identifier, and vector dimensions. Specify a model identifier that includes
its version/configuration. Vectors support 1–4096 finite values and must have nonzero
norm. Text edits invalidate old embeddings. Stale embedding submissions are rejected.

VibeCab does not generate embeddings or call model services itself. Tasks and claims
work without embeddings. Search currently scans matching vectors exactly; an index
can be added once a stable model/dimension is chosen and project size warrants it.
The UI's search box currently performs text filtering, not vector search.

## Web interface

- Project navigation and Inbox / Ready / Blocked / In progress / Finished columns.
- Batch idea capture, shared context, priorities, search, and current agent ownership.
- Dependency analysis with preview/apply, downstream links, and execution layers.
- Task editing, browser-session claiming, completion, handoff, and activity history.
- Keyboard shortcuts: **N** to capture, **/** to search, **Escape** to close dialogs.
- Responsive layouts, local assets, and no required drag gestures.

Browser claims renew once a minute while the page is running. Closing or reloading
the page loses its in-memory token; the lease then expires naturally. Agents should
use their own session identifiers and heartbeat loop.

Design sources and rationale: [docs/ui-research.md](docs/ui-research.md).

## Validation

API tests launch real daemon processes and use PostgreSQL with pgvector. They write
fixtures, so always use a dedicated disposable database:

```sh
createdb vibecab_test
DATABASE_URL=postgresql://localhost/vibecab_test cargo test --locked
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
```

Browser tests use Node.js only as a development tool:

```sh
npm ci
npx playwright install chromium
# Start a second daemon against a disposable UI test database, then:
VCAB_TEST_URL=http://127.0.0.1:7433 npm run test:ui
```

Set `CHROMIUM_PATH` to use an already installed Chromium executable. Tests create
projects/tasks, exercise real UI/API behavior, scan with axe, and save screenshots
and accessibility results under ignored `artifacts/`. They never run against the
personal database unless explicitly pointed there.

## Scope and next improvements

The API and local UI are implemented. Dedicated CLI subcommands and MCP transport
are not yet implemented; agents can use the documented HTTP interface now. Projects
can be created/listed but editing and archiving are still pending. Other useful next
steps are paginated task/history queries, an optional embedding worker, and richer
agent handoff notes. No external integrations or model services are required.
