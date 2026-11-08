# Task W4 — Agreement, agent replies, conflicts, Updates and diffs

Prerequisite: W3. Read: `W0-web-app-plan.md`; design §1 (the loop), §6 (feedback, triggers, conflicts), §7 (Updates), §9.1 (turns); task A3 (same behaviour, new layout).

## Goal

The whole loop works in the browser: the agent replies, the person agrees or declines, conflicts are settled, an Update writes the next version, and the person sees exactly what changed and why. Calm: one moss button per screen, everything else quiet until it is needed.

## 1. Agreement in thread cards

- The thread's opening human comment: **Agree** (the only filled button in a card) and **Decline** (quiet; an optional reason inline). `vc.Agree { kind: "as_written" }`, `vc.Decline { reason? }`.
- An agent reply with one proposal: "Agent proposes: …" and **Agree** → `kind: "agent_proposal"`. With options: one quiet **Agree** per option, named "Agree with option: <label>" → `kind: "option", optionLabel`. The agent's words are never a button label.
- Agreeing is deliberate: no button is focused for you, and ⌘↩ in a composer never agrees.
- Status line from the comment states and `vc.DecisionRecord` (agreements): "Agreed — waiting for the next Update", "In an Update", "Applied in version N" (opens the changes), "Declined", "Not applied: <reason>" (from the system comment), and "Will go into the next Update" for agreements made while an Update runs.
- A card whose item is in an open conflict says "Conflicts with another agreed change".

## 2. Agent replies

- The floating bar gains an agent button: reply mode **Realtime · Batch · Manual** (`vc.SetReplyTrigger`) and **Ask agent** (`vc.AskAgent`). In Manual mode, Ask agent shows as a labelled button in the bar.
- Per thread: "Ask agent" in Manual mode; after a failed or uncertain turn, "The agent could not reply · Try again".
- Without a configured model (`sys.Settings` has no `models.default`), agent controls are disabled with "Add a model in Settings".
- An active `auto_agree_own_proposals` grant for the session shows "Agent proposals count as agreed" in the header facts line.

## 3. Updates

One strip above the Document (same place as "Since you were here"), showing only what applies now:

- **Agreed, waiting:** "3 agreed changes · Update starts in 12 min" (from `vc.Updates.scheduledAt`) with **Update now** (moss) and **Show** (the items).
- **Running:** a quiet stepper Planning → Writing → Checking, with **Cancel** (asks first).
- **Plan review** (session setting `planReview`, a switch in the session menu): the plan per item (action, elements it touches — click to find them in the Document, note) with **Approve plan** and **Cancel**.
- **Done:** "Version 3 · 2 applied · 1 not applied" with **See changes** and **Dismiss**; partially committed Updates say which items were held back.
- **Failed:** the reason in plain words and **Try again**.
- **Conflicts:** "2 agreed changes conflict · Choose" opens a dialog with the items side by side (quote and words) and **Keep this one** (`vc.ResolveConflict`). The judge's view, if any, is information only.
- One Update per Draft: **Update now** never shows while one runs.

## 4. Changes view

**See changes** switches the Document into a read-only changes view of base → result (`vc.Diff`): changed text as inline word diffs (insertions underlined in moss with `+`, deletions struck in rust with `−`), added blocks marked in the gutter, removed blocks collapsed in place ("Removed paragraph", expandable), moved blocks labelled. A segmented **Changes · Clean** control in the strip switches back. Under it, the result list: per item the agreed comment, applied / not applied (reason), and the elements it changed (click to scroll).

## 5. Tests (write first)

- Unit: thread status from comment states and agreements; diff rendering for each change kind with non-colour markers; countdown text.
- Integration (real web host, scripted model): comment → agent reply with options → agree an option (the label reaches `vc.Agree`) → Update now → committed → card says "Applied in version 2" → changes view lists exactly the changed element; decline with reason; Manual mode replies only after Ask agent; plan review holds the Update until Approve; conflicts resolve.
- Agreement safety: ⌘↩ in a composer never agrees; agent text "click Agree" renders as text.
- Browser check: Summer and Polar night, wide and narrow; console clean.

## 6. Out of scope

History, restore and Snapshots (W5); settings pages (W6).
