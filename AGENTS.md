# AGENTS.md — VibeCab core engine (local build)

Instructions for coding agents working in this repository. Read this file fully before every task. If anything here conflicts with a task file, this file wins; record the conflict in `docs/questions.md` and stop.

## 1. What this repository is

The **headless core engine** for VibeCab (a comment-driven human + AI collaboration workspace) and TMR (The Majority Report, a bounded multi-model deliberation engine).

- Architecture: `docs/design/core-engine-local.md`. Read the sections a task references before writing code.
- Current build target: **local, single person**. One engine instance per workspace, SQLite, one serial writer.
- UI only as specified by app tasks A1–A5.

Out of scope until a task says otherwise: the cloud build (PostgreSQL, multi-tenancy, roles), live co-editing, real model-provider calls in tests, product journeys (e.g. the writer's story), `page` / `canvas` / `music` media kinds.

## 2. Stack

- **TypeScript 7**, `strict: true`, `noUncheckedIndexedAccess: true`, ES modules, Node.js 26 LTS (26.13.0).
- **pnpm 12** workspaces.
- **Vitest 5** for tests; **fast-check** for property-based tests.
- **ESLint 10** with TypeScript ESLint 8 (the lint workspace runs TypeScript 6 for parser compatibility); **Prettier 3** with `printWidth: 120`.
- **JSON Schema (draft 2020-12)** for the contract; **ajv** for validation; types generated with **json-schema-to-typescript**.
- **better-sqlite3** (WAL mode) for storage.
- **ulid** for ids; **canonicalize** (RFC 8785) for canonical JSON; **fractional-indexing** for sibling order; **diff** for word-level text diffs.

Do not add other runtime dependencies without recording why in `docs/decisions.md`.

## 3. Repository layout

```
contract/                 # JSON Schemas — the single source of truth for the outward surface
  schemas/                # envelope, context, errors, operations, events, media kinds
  generated/              # generated TS types (never edit by hand)
engine/
  src/
    kernel/               # serial command queue, idempotency, events, outbox, jobs
    content/              # media kinds, elements, revisions, versions, commit, diff, anchors
    feedback/             # comments, agreement, reply triggers            (later tasks)
    updates/              # planning, write-set enforcement                 (later tasks)
    agent/                # turns, tools, context manifests                 (later tasks)
    gateway/              # model gateway interface, ledger, providers      (later tasks)
    tmr/                  # deliberation engine                             (later tasks)
    integration/          # review requests, finding applicability          (later tasks)
    lifecycle/            # output sets, export, backup, trash, purge       (later tasks)
    storage/              # repository interfaces + SQLite implementation
    engine.ts             # Engine interface + lifecycle (start / drain / stop)
  test/
adapters/
  in-process/             # direct calls into Engine
  http/                   # HTTP on 127.0.0.1, SSE events
  cli/                    # (later task)
  mcp-server/             # (later task)
  mcp-client/             # (later task)
host/                     # shared local engine host
apps/web/                 # the web app: React renderer (src/) and its local web host (server/)
apps/macos/               # Electron shell around the web app: window, menu, menu-bar item (no preload)
docs/
  design/                 # architecture (read-only for agents unless a task says so)
  tasks/                  # one file per task
  decisions.md            # every choice not dictated by the design, with reason
  questions.md            # spec gaps found while working
```

Dependency direction is strict: `adapters → engine → contract`. `engine` never imports from `adapters`. Domain modules (`content`, `feedback`, `updates`, `agent`, `tmr`, `integration`) never import `better-sqlite3` or any transport; they use interfaces from `storage/` and `kernel/`.

## 4. Commands

```
pnpm install
pnpm gen          # regenerate contract/generated from contract/schemas
pnpm typecheck
pnpm lint
pnpm test         # unit + property tests
pnpm test:prop    # property tests with more runs (FC_NUM_RUNS=1000)
pnpm format       # format the repository with Prettier
pnpm format:check # verify formatting
```

Lint rejects lines over 160 characters outside prompts and generated files, and forbids domain modules from importing adapters or `better-sqlite3`.

A task is not done until `pnpm gen && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check` passes with a clean `git status` for generated files.

## 5. Hard invariants (never break; each has or must get a test)

1. **The contract is the only outward surface.** Adapters call `command`, `query`, `subscribe`, `putBlob`, and `getBlob` with an auth credential and request metadata. The engine alone resolves credentials into `CallContext`; adapters cannot choose `channel` or `scope`. In-process trusted-host credentials are minted by the engine composition root and cannot be constructed by adapters.
2. **Schemas first.** Any new operation, event, payload or error starts as a JSON Schema in `contract/schemas/`, then `pnpm gen`, then code. Never hand-write a type that a schema defines.
3. **Validate at every boundary.** Every command payload, query argument, event payload, stored JSON element and model output is validated against its schema with ajv. Invalid input → `ContractError { code: "invalid" }`. No `as` casts on unvalidated data. No `any`.
4. **Single writer.** All state changes go through the kernel's serial command queue, one SQLite transaction per command: validate → authorize → mutate → append events → append outbox → commit. Nothing else writes to the database.
5. **Idempotency.** `commandId` is unique; a repeated `commandId` returns the stored result and changes nothing.
6. **Untouched means untouched.** A commit may change only the elements in its declared write set. Every other element in the new version has the identical revision hash as at head. This is enforced by the commit code, not by callers.
7. **Versions are immutable and linear per artifact.** History is never rewritten; restore creates a new version.
8. **Element ids are engine-generated, opaque, never reused, never derived from content or position.** Callers (including the agent, later) may only reference existing ids or use temporary ids of the form `new:<n>`, which the engine replaces at commit and returns as a mapping.
9. **Agents never act as humans.** The `agent` principal exists only inside the engine; adapters can produce only `human` or `system`. An agent can never create or widen a grant. (Enforced from the task that introduces agents.)
10. **Admin operations are not callable through the MCP channel**, regardless of token scope. (Enforced from the task that introduces MCP.)
11. **No model call without a budget reservation**, and versions from an Update commit only at the end. (Enforced from the tasks that introduce the gateway and Updates.)
12. **Determinism in tests.** Time comes from an injected `Clock`; ids from an injected `IdGenerator`; randomness from an injected seed. Tests never touch the network or real model providers; use the scripted fake provider when one is needed.
13. **Secrets never appear** in logs, events, errors, exports or snapshots.

## 6. Coding rules

- Errors: only `ContractError` crosses the engine boundary, with `code`, `message`, `retryable`, optional `details`. Internal exceptions are mapped; unknown ones become `internal`.
- Money is integer micro-units. Timestamps are RFC 3339 UTC strings at the boundary.
- Hashes are `sha256` hex of RFC 8785 canonical JSON.
- Keep functions small and pure in domain modules; side effects live in kernel, storage and adapters.
- No global mutable state; everything hangs off an engine instance.
- Prefer explicit names from the design (`Version`, `ElementRevision`, `Anchor`, `writeSet`, `baseVersion`) over new vocabulary.
- Comments explain *why*; don't restate code.
- Cross-module calls go through ports: a domain module that others need exports a narrow typed port interface (e.g. `FeedbackPort`, `UpdatesPort`) from its `index.ts`, next to its `EngineModule`. `engine.ts` (the composition root) constructs modules and injects the ports they need. A module never writes another module's records through the repository and never deep-imports another module's internals.

## 7. Testing rules

- Write the invariant and property tests named in the task **before** the implementation.
- Never weaken, skip or delete a test to make it pass. If a test seems wrong, record it in `docs/questions.md` and stop.
- Every bug fix comes with a test that failed before the fix.
- Property tests must be reproducible: log the seed on failure.
- Adapter tests run the shared **contract test suite** (`engine/test/contract/`) against each adapter; an adapter may not have behaviour the suite can't observe.

## 8. How to work

1. Read this file, the task file in `docs/tasks/`, and the design sections it cites.
2. If the task or design is ambiguous on something that changes behaviour, **do not guess**: write the question in `docs/questions.md` (what, where, options, your recommendation) and either stop or proceed only with the parts that don't depend on it.
3. Small choices the design leaves open (helper libraries, internal naming, table indexes) are fine: record them in `docs/decisions.md` with one line of reason.
4. Work in small commits with clear messages. Do not modify `docs/design/` unless the task says so.
5. Stop at the end of the task. Finish with a short report: what was built, test results, decisions recorded, open questions.

## 9. App

1. The renderer talks to the engine only through the `ContractBridge` interface; it never holds a token, opens a socket, or imports engine code.
2. Engine names (`artifact`, `doc`, `OutputSet`, ids, operation names) never appear in user-visible text. User-facing terms come only from `apps/web/src/copy/terms.ts`: **Draft**, **Document**, **Snapshot**, **Session**, **Update**, **Agree / Decline**.
3. CLI commands, MCP tool names, contract operations and the HTTP API keep engine names. Display-name changes belong in `terms.ts`.
4. User and agent text is rendered as text, never as HTML.

## 10. The `doc` media kind (engine name; the user-facing name will differ)

`doc` is VibeCab's native structured document: a tree of blocks. PDF, DOCX, Google Docs and Markdown are import/export formats, not `doc` itself.

| Element type | Props | Content | Children |
|---|---|---|---|
| `heading` | `level` 1–6 | `text` | — |
| `paragraph` | — | `text` | — |
| `list` | `ordered` boolean | — | `list_item` |
| `list_item` | — | `text` | optional nested `list` |
| `quote` | — | `text` | — |
| `code_block` | `language` optional | `text` (raw, no inline markup) | — |
| `table` | `headerRow` boolean | — | `table_row` |
| `table_row` | — | — | `table_cell` |
| `table_cell` | — | `text` | — |
| `image` | `alt`, `caption` optional | `blobHash` | — |
| `divider` | — | — | — |
| `callout` | `tone`: `info` \| `note` \| `warning` | `text` | — |

- **Inline formatting** lives inside `text` as a validated inline-Markdown subset: `**bold**`, `*italic*`, `` `code` ``, `[label](url)`. Nothing else (no HTML, no headings or lists inside `text`). Stored in canonical form.
- **Top-level blocks** have `parentId: null`. Children must be of an allowed type for their parent.
- **Order** among siblings uses fractional-index strings, generated by the engine at commit.
- **Addressing:** comments and edits point at an element id; a location inside a text element uses `{ quote, prefix, suffix }`.
- **Split / merge:** splitting keeps the original id on the first part and assigns new ids to the rest; merging keeps the surviving id and removes the others.
