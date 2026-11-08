# Task W5 — History, Snapshots, export, Trash, Ideas and Projects

Prerequisite: W4. Read: `W0-web-app-plan.md`; design §9.3, §14; task A4 §1–§4 (same behaviour, new layout); the Ideas and Projects decision of 2026-10-31 in `docs/decisions.md`.

## Goal

Everything around the loop, in the same calm language: go back in time, keep stable outputs, get files out, delete safely, and gather Ideas into Sessions and Projects.

## 1. History (per Draft)

- A clock button in the session's floating bar opens a sheet from the right: versions newest first — "Version 3 · Update by the agent for you · 2h ago", "Restored from version 1", "Imported", plus Snapshot and label chips.
- Choosing a version shows it read-only in place of the Document with a strip: "Viewing version 1 · read only" and **Back to latest**, **Compare with latest** (the W4 changes view between the two), **Restore this version** (asks: "Creates version 4 with the content of version 1. Nothing is lost." → `vc.RestoreVersion`).
- **Export…** for the latest or the viewed version.

## 2. Snapshots

- A bookmark button in the bar: **Save snapshot** — choose Drafts (all in the session by default), optional label → `vc.CreateOutputSet`. The word in the UI is "Snapshot".
- Snapshots listed in the history sheet: label, time, members ("Launch notes · version 2"), **Export…**, **Add label** (`vc.Label`). Labels never move.

## 3. Export

- Dialog: Markdown / HTML / JSON, with "Include threads" and "Include decisions" → `vc.Export`; wait for the export record to complete; the browser downloads the file (named after the Draft or Snapshot). Failures say so in plain words.

## 4. Trash

- `/trash`: trashed Drafts, Sessions, Ideas and Projects (the difference between `includeTrashed` and normal queries), each with **Restore** and **Delete permanently**.
- Delete permanently shows `vc.PurgePreview` as one plain sentence ("This removes 3 versions, 4 comments and 1 Snapshot. It cannot be undone."), asks for the title to be typed, then `vc.Purge`. **Empty Trash** does the same for everything, confirmed by typing "empty trash".
- A line says items are removed for good after the retention period (`trashRetentionDays`).

## 5. Ideas and Projects

- Sidebar: Ideas and Projects join Home, Needs you and Drafts.
- `/ideas`: a capture field at the top ("Write an idea down", ↩ saves → `vc.CaptureIdea`), then the ideas newest first with where they went (sessions, projects); row menu: **Start a session** (`vc.StartSession { ideaIds }`), **Add to project** (`vc.AttachProjectItem`), **Move to Trash**.
- `/projects`: projects with their counts; **New project** (title, background). `/p/:projectId`: the project's background, then its Ideas, Drafts and Sessions as the same quiet rows, with **Add** for each kind and **Remove from project** (`vc.DetachProjectItem`).

## 6. Tests (write first)

- Integration (real web host): restore creates the next version with the old content and the history lists "Restored from version N"; read-only view shows the old text; Snapshot freezes versions while a later version lands; label added; export completes and the downloaded bytes equal the blob; purge preview sentence matches the engine's numbers and purge removes the item; trash and restore; capture an idea, start a session from it, create a project and add the idea.
- Browser check: Summer and Polar night, wide and narrow; console clean.

## 7. Out of scope

Settings, first run, the per-block decision record ("Why is this here?"), and accessibility audit (W6).
