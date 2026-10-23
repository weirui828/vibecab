# UI decisions and sources

The interface supports a personal workspace whose main workers are agents. Human
interaction should make capture and inspection quick, while explaining why work is
blocked and who owns it. Research was applied to interactions rather than visual
imitation of another product.

## Sources reviewed

- [W3C ARIA Authoring Practices: Modal Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
  ([official source reviewed](https://github.com/w3c/aria-practices/blob/main/content/patterns/dialog-modal/dialog-modal-pattern.html)).
  Focus belongs inside an open dialog, Escape closes it, and closing returns focus
  to an appropriate control. VibeCab uses native dialog elements, visible close
  controls, named fields, and explicit focus restoration after task updates.
- [W3C ARIA Authoring Practices: Disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)
  ([official source reviewed](https://github.com/w3c/aria-practices/blob/main/content/patterns/disclosure/disclosure-pattern.html)).
  Secondary details should be expandable with clear keyboard-operable controls.
  Activity history and permanent deletion use native details/summary disclosure.

The W3C website was unavailable from the cloud network; the authoritative source
files were retrieved from the W3C GitHub repository instead.

## Visual language

The interface uses Wei's Tundra design system: Icelandic tundra colors (moss on
basalt, lichen, glacier meltwater, rust, sedge), low saturation with contrast carried
by lightness, hairlines instead of shadows (only overlays float), generous space, and
the þúfa (tussock) half-ellipse as the one decorative shape. Fraunces sets headings,
Instrument Sans the body, JetBrains Mono IDs and numbers. The three typefaces are SIL
OFL 1.1, bundled in `web/fonts` with their licenses and served by the binary.

- The horizon draws one tussock per task state, its height proportional to the count.
- The dependency plan is drawn as strata: foundations first, one band per layer.
- Task details open as a full-height sheet on the right (a bottom sheet on phones).
- Both Tundra themes are supported: Summer tundra (light) and Polar night (dark). The
  rail switch offers Auto, Summer and Polar night and remembers the choice locally.
- Copy follows Tundra's voice: short, plain, like field notes; no exclamation marks.
- The wordmark is plain text until a logo is chosen.

## Applied design choices

- A persistent project rail and five stable columns distinguish Inbox, Ready,
  Blocked, In progress, and Finished. Labels accompany status colors.
- Capture accepts one idea per line, with optional shared context. No drag operation
  is required to organize work. Batch retries use a persisted idempotency key.
- Task details combine context, current ownership, direct prerequisites, and
  downstream impact. Dependency edits have explicit preview/apply steps; a stale
  graph is rejected rather than silently replacing another agent's changes.
- The dependency plan groups tasks into prerequisite-first layers instead of
  drawing crossing edges across a dense graph. It explicitly distinguishes
  structural order from current eligibility to claim.
- Search, priority filters, N for capture, and / for search keep frequent operations
  short. Shortcuts do not fire inside inputs or open dialogs.
- Mobile layouts retain a horizontally scrollable board within the viewport;
  forms and project navigation adapt to narrow screens.
- All assets ship in the Rust executable. The UI calls the same public API agents
  use. No frontend server or third-party runtime resources are needed.

## Validation

`tests/ui.cjs` exercises project creation, batch capture, dependency preview/apply,
claiming, completion and downstream unblocking, search, plan navigation, mobile
layout, escaping of untrusted task text, the theme switch, and axe WCAG A/AA scans
in both themes. Screenshots in
`artifacts/` are generated from a disposable test project, never seeded into the
personal workspace. Automated checks supplement visual and keyboard inspection;
they do not establish complete accessibility conformance.
