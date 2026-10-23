"use strict";
const $ = (s) => document.querySelector(s);
const state = {
  projects: [],
  project: null,
  graph: null,
  view: "board",
  request: 0,
  selected: null,
};
const priorityNames = ["Urgent", "High", "Normal", "Low"];
const columns = [
  ["inbox", "Inbox", "No loose ideas."],
  ["ready", "Ready", "Nothing ready. Finish a prerequisite to free one."],
  ["blocked", "Blocked", "Nothing is waiting on prerequisites."],
  ["active", "In progress", "No agent is out on a task."],
  ["done", "Finished", "Finished work settles here."],
];
const stateNames = Object.fromEntries(
  columns.map(([key, title]) => [key, title]),
);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function button(text, cls, fn) {
  const e = el("button", cls, text);
  e.type = "button";
  if (fn) e.addEventListener("click", fn);
  return e;
}
function clock(time) {
  return new Date(time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
function notify(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => ($("#toast").hidden = true), 4500);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      `Server returned ${response.status}. Please refresh and try again.`,
    );
  }
  if (!response.ok)
    throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}
const send = (path, method, body) =>
  api(path, { method, body: JSON.stringify(body) });
function storageGet(key, fallback = null) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
let session;
try {
  session = sessionStorage.getItem("vcab-session") || crypto.randomUUID();
  sessionStorage.setItem("vcab-session", session);
} catch {
  session = crypto.randomUUID();
}
const owned = new Map();
function closeDialog(dialog) {
  dialog.close();
}
function openDialog(dialog) {
  dialog.querySelector(".form-error")?.replaceChildren();
  dialog.showModal();
}
document
  .querySelectorAll(".close-dialog")
  .forEach((b) =>
    b.addEventListener("click", () => closeDialog(b.closest("dialog"))),
  );
function currentProject() {
  return state.projects.find((p) => p.id === state.project);
}
function graphTasks() {
  return state.graph?.tasks || [];
}
function info(id) {
  return (
    state.graph?.analysis[id] || {
      dependencies: [],
      dependents: [],
      blockers: [],
      ancestors: [],
      descendants: [],
      unblocks_count: 0,
    }
  );
}
function taskState(t) {
  if (t.status === "BACKLOG") return "inbox";
  if (["DONE", "CANCELED"].includes(t.status)) return "done";
  if (
    t.status === "IN_PROGRESS" &&
    Date.parse(t.lease_until) > Date.now() + (state.clockOffset || 0)
  )
    return "active";
  return info(t.id).blockers.length ? "blocked" : "ready";
}
function matches(t) {
  const query = $("#search").value.toLowerCase().trim();
  const priority = $("#priority-filter").value;
  return (
    (!query ||
      `${t.title} ${t.description} ${t.claimed_by || ""} ${t.id}`
        .toLowerCase()
        .includes(query)) &&
    (priority === "" || String(t.priority) === priority)
  );
}
function renderProjects() {
  const root = $("#projects");
  root.replaceChildren();
  for (const p of state.projects) {
    const b = button(
      "",
      `project-item${p.id === state.project ? " active" : ""}`,
      () => selectProject(p.id),
    );
    b.append(el("span", "project-mound"), el("span", "project-name", p.name));
    if (p.repo_path) b.append(el("span", "project-path", p.repo_path));
    b.dataset.projectId = p.id;
    b.setAttribute("aria-current", p.id === state.project ? "page" : "false");
    root.append(b);
  }
}
function card(t) {
  const c = button("", "task-card", () => openTask(t.id));
  c.dataset.taskId = t.id;
  c.setAttribute(
    "aria-label",
    `${t.title}, ${taskState(t)}, ${priorityNames[t.priority]} priority`,
  );
  const top = el("div", "card-top");
  top.append(
    el("span", "task-id", `VC-${t.id.slice(0, 5).toUpperCase()}`),
    el(
      "span",
      `priority p${t.priority}`,
      `P${t.priority} · ${priorityNames[t.priority]}`,
    ),
  );
  c.append(top, el("h3", "", t.title));
  if (t.description) c.append(el("p", "card-description", t.description));
  const bottom = el("div", "card-bottom");
  const a = info(t.id);
  if (a.blockers.length)
    bottom.append(
      el(
        "span",
        "dependency-badge",
        `Waiting on ${a.blockers.length} prerequisite${a.blockers.length === 1 ? "" : "s"}`,
      ),
    );
  else if (a.dependencies.length && t.status !== "DONE")
    bottom.append(
      el(
        "span",
        "",
        `${a.dependencies.length} prerequisite${a.dependencies.length === 1 ? "" : "s"} met`,
      ),
    );
  if (taskState(t) === "active")
    bottom.append(
      el(
        "span",
        "owner-badge",
        `${t.claimed_by} · until ${clock(t.lease_until)}`,
      ),
    );
  else if (t.status === "IN_PROGRESS")
    bottom.append(
      el("span", "expired-badge", "Lease expired · claimable again"),
    );
  if (t.status === "DONE") bottom.append(el("span", "done-badge", "Completed"));
  if (t.status === "CANCELED") bottom.append(el("span", "", "Canceled"));
  if (!bottom.childNodes.length && a.unblocks_count)
    bottom.append(el("span", "", `Unlocks ${a.unblocks_count} downstream`));
  if (bottom.childNodes.length) c.append(bottom);
  return c;
}
function render() {
  const focusedTask =
    document.activeElement.closest(".task-card")?.dataset.taskId;
  const focusedProject =
    document.activeElement.closest(".project-item")?.dataset.projectId;
  renderProjects();
  if (focusedProject)
    document.querySelector(`[data-project-id="${focusedProject}"]`)?.focus();
  const p = currentProject();
  $("#breadcrumb").textContent = p ? "Project" : "Your projects";
  $("#project-title").textContent = p?.name || "VibeCab";
  $("#capture").disabled = !p;
  $("#capture").hidden = !p;
  $("#empty-workspace").hidden = !!p;
  $("#workspace").hidden = !p;
  const metrics = $("#metrics");
  metrics.replaceChildren();
  if (!p) {
    $("#project-subtitle").textContent =
      "Local task coordinator for your agents.";
    return;
  }
  if (!state.graph) return;
  const all = graphTasks();
  const counts = Object.fromEntries(columns.map(([key]) => [key, 0]));
  all.forEach((t) => counts[taskState(t)]++);
  const agents = new Set(
    all.filter((t) => taskState(t) === "active").map((t) => t.claimed_by),
  ).size;
  $("#project-subtitle").textContent = [
    `rev ${state.graph.revision}`,
    `${all.length} task${all.length === 1 ? "" : "s"}`,
    `${agents} agent${agents === 1 ? "" : "s"} out`,
    p.repo_path,
  ]
    .filter(Boolean)
    .join(" · ");
  // Horizon: one tussock per state; height is proportional to its count.
  const tallest = Math.max(1, ...Object.values(counts));
  for (const [key, title] of columns) {
    const col = el("div", "mound-col");
    col.dataset.state = key;
    const ground = el("div", "mound-ground");
    const mound = el("div", "mound");
    mound.style.setProperty("--h", `${(counts[key] / tallest) * 64}px`);
    ground.append(mound);
    const label = el("div", "mound-label");
    label.append(
      el("span", "mound-count", String(counts[key])),
      el("span", "label", title),
    );
    col.append(ground, label);
    metrics.append(col);
  }
  const visible = all.filter(matches);
  $("#result-count").textContent =
    `${visible.length} of ${all.length} tasks · updated ${clock(new Date())}`;
  const board = $("#board");
  board.replaceChildren();
  board.hidden = state.view !== "board";
  $("#plan").hidden = state.view !== "plan";
  for (const [key, title, empty] of columns) {
    const col = el("section", "column");
    col.dataset.state = key;
    col.setAttribute("aria-label", title);
    const subset = visible.filter((t) => taskState(t) === key);
    const head = el("h2", "column-title");
    head.append(
      el("span", "dot"),
      el("span", "", title),
      el("span", "count", String(subset.length)),
    );
    if (["inbox", "ready"].includes(key)) {
      const add = button("+", "icon-button", () =>
        showCapture(key === "inbox"),
      );
      add.setAttribute("aria-label", `Add to ${title}`);
      head.append(add);
    }
    col.append(head);
    subset.forEach((t) => col.append(card(t)));
    if (!subset.length)
      col.append(
        el(
          "div",
          "column-empty",
          visible.length !== all.length ? "No matching tasks." : empty,
        ),
      );
    board.append(col);
  }
  const plan = $("#plan");
  plan.replaceChildren(
    el(
      "p",
      "plan-intro",
      "Prerequisites come first, like layers of rock. Tasks in one layer do not depend on each other. Layers show structure, not a schedule: inbox items, unfinished prerequisites and active leases still decide what agents can claim.",
    ),
  );
  state.graph.execution_layers.forEach((layer, i) => {
    const tasks = layer
      .map((id) => all.find((t) => t.id === id))
      .filter((t) => t && matches(t));
    if (!tasks.length) return;
    const row = el("section", "plan-layer");
    const label = el("h2", "layer-label", `Layer ${i + 1}`);
    label.append(el("span", "", i ? `After layer ${i}` : "Foundations"));
    const items = el("div", "layer-tasks");
    tasks.forEach((t) => items.append(card(t)));
    row.append(label, items);
    plan.append(row);
  });
  if (!all.length)
    plan.append(
      el(
        "p",
        "column-empty",
        "Capture a few ideas, then connect their dependencies here.",
      ),
    );
  if (focusedTask && !document.querySelector("dialog[open]"))
    document
      .querySelector(`#${state.view} [data-task-id="${focusedTask}"]`)
      ?.focus();
}
async function refresh() {
  const project = state.project;
  const ticket = ++state.request;
  try {
    const graph = project ? await api(`/projects/${project}/graph`) : null;
    if (ticket !== state.request || project !== state.project) return;
    state.graph = graph;
    state.clockOffset = graph ? Date.parse(graph.server_time) - Date.now() : 0;
    $("#connection").textContent = "Local & connected";
    $("#connection-dot").classList.remove("offline");
    $("#notice").textContent = "";
    render();
  } catch (e) {
    if (ticket !== state.request) return;
    $("#connection").textContent = "Connection interrupted";
    $("#connection-dot").classList.add("offline");
    $("#notice").textContent = `Couldn't refresh your workspace. ${e.message}`;
  }
}
async function selectProject(id) {
  if (id === state.project && state.graph) return;
  state.project = id;
  state.graph = null;
  storageSet("vcab-project", id);
  render();
  await refresh();
}
async function load() {
  try {
    state.projects = await api("/projects");
    const remembered = storageGet("vcab-project");
    const next =
      state.projects.find((p) => p.id === state.project) ||
      state.projects.find((p) => p.id === remembered) ||
      state.projects[0];
    if (next) await selectProject(next.id);
    else {
      state.project = null;
      await refresh();
    }
  } catch (e) {
    $("#notice").textContent = e.message;
    $("#connection").textContent = "Unable to connect";
    $("#connection-dot").classList.add("offline");
  }
}
function showCapture(backlog = true) {
  if (!state.project) return;
  const form = $("#capture-form");
  form.reset();
  form.elements.backlog.value = String(backlog);
  form.dataset.requestId = crypto.randomUUID();
  delete form.dataset.payload;
  $("#capture-project").textContent = currentProject()?.name || "";
  openDialog($("#capture-dialog"));
}
// Theme: Auto follows the system; Summer and Polar night are Tundra's two themes.
function applyTheme(choice) {
  if (choice) document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  document
    .querySelectorAll("[data-theme-choice]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.themeChoice === choice)),
    );
}
applyTheme(document.documentElement.dataset.theme || "");
document.querySelectorAll("[data-theme-choice]").forEach((b) =>
  b.addEventListener("click", () => {
    applyTheme(b.dataset.themeChoice);
    try {
      if (b.dataset.themeChoice)
        localStorage.setItem("vcab-theme", b.dataset.themeChoice);
      else localStorage.removeItem("vcab-theme");
    } catch {}
  }),
);
$("#capture").onclick = () => showCapture();
$("#new-project").onclick = $("#first-project").onclick = () => {
  $("#project-form").reset();
  openDialog($("#project-dialog"));
};
$("#project-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("[type=submit]");
  submit.disabled = true;
  try {
    const data = new FormData(form);
    const name = data.get("name").trim();
    if (!name) throw new Error("Give your project a name.");
    const created = await send("/projects", "POST", {
      name,
      repo_path: data.get("repo_path") || null,
    });
    state.projects = await api("/projects");
    closeDialog($("#project-dialog"));
    await selectProject(created.id);
    notify("Project created. Make room for your ideas.");
  } catch (e) {
    form.querySelector(".form-error").textContent = e.message;
  } finally {
    submit.disabled = false;
  }
};
$("#capture-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("[type=submit]");
  submit.disabled = true;
  try {
    const data = new FormData(form);
    const titles = data
      .get("ideas")
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!titles.length) throw new Error("Add at least one idea.");
    if (titles.length > 200)
      throw new Error("Capture up to 200 ideas at once.");
    const tasks = titles.map((title, i) => ({
      key: `idea-${i + 1}`,
      title,
      description: data.get("description"),
      backlog: data.get("backlog") === "true",
      priority: Number(data.get("priority")),
    }));
    const fingerprint = JSON.stringify(tasks);
    if (form.dataset.payload && form.dataset.payload !== fingerprint)
      form.dataset.requestId = crypto.randomUUID();
    form.dataset.payload = fingerprint;
    await send(`/projects/${state.project}/capture`, "POST", {
      request_id: form.dataset.requestId,
      tasks,
    });
    closeDialog($("#capture-dialog"));
    await refresh();
    notify(`${titles.length} idea${titles.length === 1 ? "" : "s"} captured.`);
  } catch (e) {
    form.querySelector(".form-error").textContent = e.message;
  } finally {
    submit.disabled = false;
  }
};
$("#search").oninput = render;
$("#priority-filter").onchange = render;
$("#refresh").onclick = async () => {
  await load();
  await refresh();
};
for (const view of ["board", "plan"])
  $(`#${view}-view`).onclick = () => {
    state.view = view;
    for (const name of ["board", "plan"]) {
      $(`#${name}-view`).classList.toggle("active", name === view);
      $(`#${name}-view`).setAttribute("aria-pressed", String(name === view));
    }
    render();
  };
document.addEventListener("keydown", (e) => {
  if (
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    e.target.matches("input,textarea,select") ||
    document.querySelector("dialog[open]")
  )
    return;
  if (e.key === "n" || e.key === "N") {
    e.preventDefault();
    showCapture();
  }
  if (e.key === "/") {
    e.preventDefault();
    $("#search").focus();
  }
});
function field(label, type, value) {
  const wrapper = el("label", "", label);
  const input = el(type);
  input.value = value ?? "";
  input.setAttribute("aria-label", label);
  wrapper.append(input);
  return [wrapper, input];
}
function selectField(label, options, value) {
  const [wrapper, input] = field(label, "select", "");
  for (const [v, t] of options) {
    const option = el("option", "", t);
    option.value = v;
    input.append(option);
  }
  input.value = String(value);
  return [wrapper, input];
}
function taskLink(id) {
  const task = graphTasks().find((t) => t.id === id);
  return button(task?.title || id, "dependency-link", () => openTask(id));
}
async function openTask(id) {
  const task = graphTasks().find((t) => t.id === id);
  if (!task) return;
  state.selected = id;
  const graphRevision = state.graph.revision;
  const analysis = info(id);
  const editable = !["IN_PROGRESS", "DONE"].includes(task.status);
  const root = $("#task-detail");
  root.replaceChildren();
  $("#task-short-id").textContent =
    `VC-${id.slice(0, 5).toUpperCase()} · ${stateNames[taskState(task)]}`;
  const dialog = $("#task-dialog");
  if (!dialog.open) dialog.showModal();
  const form = el("form");
  form.id = "task-form";
  const [titleLabel, title] = field("Title", "input", task.title);
  title.required = true;
  title.maxLength = 300;
  const [descriptionLabel, description] = field(
    "Context",
    "textarea",
    task.description,
  );
  description.rows = 4;
  const [priorityLabel, priority] = selectField(
    "Priority",
    priorityNames.map((n, i) => [i, n]),
    task.priority,
  );
  const [statusLabel, status] = selectField(
    "Status",
    [
      ["BACKLOG", "Inbox"],
      ["TODO", "Ready when unblocked"],
      ["CANCELED", "Canceled"],
      ...(task.status === "DONE" ? [["DONE", "Completed"]] : []),
      ...(task.status === "IN_PROGRESS"
        ? [["IN_PROGRESS", "In progress"]]
        : []),
    ],
    task.status,
  );
  const row = el("div", "form-row");
  row.append(statusLabel, priorityLabel);
  form.append(titleLabel, descriptionLabel, row);
  for (const input of [title, description, priority, status])
    input.disabled = !editable;
  const err = el("p", "form-error");
  err.setAttribute("role", "alert");
  const actions = el("div", "dialog-actions");
  const save = button("Save task", "primary");
  save.type = "submit";
  save.disabled = !editable;
  actions.append(save);
  form.append(err, actions);
  root.append(form);
  form.onsubmit = async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      await send(`/tasks/${id}`, "PATCH", {
        title: title.value.trim(),
        description: description.value,
        status: status.value,
        priority: Number(priority.value),
        expected_version: task.version,
      });
      await refresh();
      await openTask(id);
      notify("Task updated.");
    } catch (e) {
      err.textContent = `${e.message}. Close and reopen this task to load the latest version.`;
    } finally {
      save.disabled = !editable;
    }
  };
  const work = el("section", "detail-section");
  work.append(el("h3", "", "Work on this task"));
  const token = owned.get(id);
  const stateNow = taskState(task);
  if (stateNow === "active")
    work.append(
      el(
        "p",
        "lease-info",
        `${task.claimed_by} owns this task until ${new Date(task.lease_until).toLocaleTimeString()}. ${token ? "This browser owns the claim." : "Only that agent can complete or release it."}`,
      ),
    );
  if (stateNow === "ready") {
    work.append(
      el(
        "p",
        "detail-summary",
        "Claim this task for this browser session. Your claim lasts five minutes; keep this page open to renew it.",
      ),
    );
    const claimButton = button("Claim task", "primary", async () => {
      claimButton.disabled = true;
      try {
        const result = await send(`/tasks/${id}/claim`, "POST", {
          agent_id: `browser-${session.slice(0, 6)}`,
        });
        owned.set(id, result.claim_token);
        await refresh();
        await openTask(id);
        notify("Task claimed.");
      } catch (e) {
        err.textContent = e.message;
        await refresh();
      } finally {
        claimButton.disabled = false;
      }
    });
    work.append(claimButton);
  }
  if (token && stateNow === "active") {
    const [resultLabel, result] = field(
      "Result or handoff notes",
      "textarea",
      task.result || "",
    );
    result.rows = 3;
    work.append(resultLabel);
    const controls = el("div", "dialog-actions");
    for (const [op, text] of [
      ["release", "Release task"],
      ["complete", "Mark complete"],
    ]) {
      const b = button(
        text,
        op === "complete" ? "primary" : "secondary",
        async () => {
          b.disabled = true;
          try {
            await send(`/tasks/${id}/${op}`, "POST", {
              claim_token: token,
              result: result.value,
            });
            owned.delete(id);
            await refresh();
            await openTask(id);
            notify(
              op === "complete"
                ? "Task completed. Dependents can move forward."
                : "Task released.",
            );
          } catch (e) {
            err.textContent = e.message;
          } finally {
            b.disabled = false;
          }
        },
      );
      controls.append(b);
    }
    work.append(controls);
  }
  if (stateNow === "blocked")
    work.append(
      el(
        "p",
        "detail-summary",
        "Finish or revise the prerequisites below before claiming this task.",
      ),
    );
  if (stateNow === "inbox")
    work.append(
      el(
        "p",
        "detail-summary",
        "Move this idea out of Inbox when the work is clear enough for an agent.",
      ),
    );
  if (task.result)
    work.append(el("p", "detail-summary", `Latest result: ${task.result}`));
  root.append(work);
  const deps = el("section", "detail-section");
  deps.append(
    el("h3", "", "Dependencies"),
    el(
      "p",
      "detail-summary",
      `${analysis.blockers.length} unfinished prerequisite${analysis.blockers.length === 1 ? "" : "s"} · ${analysis.descendants.length} downstream task${analysis.descendants.length === 1 ? "" : "s"}. An agent can analyze and update these same relationships through the API.`,
    ),
  );
  const blocking = el("div", "dependency-links");
  analysis.blockers.forEach((dep) => blocking.append(taskLink(dep)));
  deps.append(blocking);
  if (editable) {
    const options = el("div", "dependency-options");
    const candidates = graphTasks().filter((t) => t.id !== id);
    const checks = [];
    for (const t of candidates) {
      const label = el("label", "dependency-option");
      const check = el("input");
      check.type = "checkbox";
      check.setAttribute("aria-label", t.title);
      check.value = t.id;
      check.checked = analysis.dependencies.includes(t.id);
      check.disabled = analysis.descendants.includes(t.id);
      const txt = el("span", "", t.title);
      label.append(
        check,
        txt,
        el(
          "small",
          "",
          check.disabled ? "would create a cycle" : t.status.toLowerCase(),
        ),
      );
      options.append(label);
      checks.push(check);
    }
    if (!candidates.length)
      options.append(
        el(
          "p",
          "detail-summary",
          "Add another task to connect a prerequisite.",
        ),
      );
    deps.append(options);
    const [reasonLabel, reason] = field("Why this relationship?", "input", "");
    reason.placeholder = "Optional context for the next agent";
    reasonLabel.style.marginTop = "14px";
    deps.append(reasonLabel);
    const previewResult = el("div", "preview-note");
    previewResult.hidden = true;
    const depError = el("p", "form-error");
    depError.setAttribute("role", "alert");
    const controls = el("div", "dialog-actions");
    let previewed = null;
    const apply = button("Apply dependencies", "primary", () => runPlan(false));
    apply.disabled = true;
    const preview = button("Preview changes", "secondary", () => runPlan(true));
    controls.append(preview, apply);
    const body = () => ({
      expected_revision: graphRevision,
      changes: [
        {
          task_id: id,
          dependencies: checks.filter((c) => c.checked).map((c) => c.value),
          rationale: reason.value,
        },
      ],
    });
    function invalidate() {
      apply.disabled = true;
      previewed = null;
      previewResult.hidden = true;
    }
    checks.forEach((c) => c.addEventListener("change", invalidate));
    reason.oninput = invalidate;
    async function runPlan(dry) {
      preview.disabled = true;
      apply.disabled = true;
      depError.textContent = "";
      try {
        const payload = body();
        if (!dry && previewed !== JSON.stringify(payload))
          throw new Error("Preview your current changes before applying.");
        const result = await send(
          `/projects/${state.project}/dependencies`,
          "PUT",
          { ...payload, dry_run: dry },
        );
        if (dry) {
          previewed = JSON.stringify(payload);
          previewResult.textContent = `Valid plan. This task will have ${result.analysis[id].blockers.length} unfinished prerequisites. No changes saved yet.`;
          previewResult.hidden = false;
          apply.disabled = false;
        } else {
          await refresh();
          await openTask(id);
          notify("Dependencies updated.");
        }
      } catch (e) {
        depError.textContent = e.message;
      } finally {
        preview.disabled = false;
      }
    }
    deps.append(previewResult, depError, controls);
  } else {
    const existing = el("div", "dependency-links");
    analysis.dependencies.forEach((dep) => existing.append(taskLink(dep)));
    deps.append(
      existing,
      el(
        "p",
        "detail-summary",
        "Dependencies are locked while work is claimed or completed.",
      ),
    );
  }
  if (analysis.dependents.length) {
    deps.append(el("h3", "", "Unlocks next"));
    const links = el("div", "dependency-links");
    analysis.dependents.forEach((dep) => links.append(taskLink(dep)));
    deps.append(links);
  }
  root.append(deps);
  const history = el("details", "detail-section");
  history.append(el("summary", "", "Activity history"));
  const list = el("div");
  history.append(list);
  root.append(history);
  history.addEventListener("toggle", async () => {
    if (!history.open || list.childNodes.length) return;
    try {
      const events = await api(`/tasks/${id}/history`);
      for (const event of events) {
        const row = el("div", "history-item");
        const message =
          event.kind === "dependencies_changed"
            ? `Dependencies updated${event.details.rationale ? `: ${event.details.rationale}` : ""}`
            : event.kind === "created"
              ? "Task captured"
              : event.details.from !== event.details.to
                ? `${event.details.from} → ${event.details.to}`
                : "Task details updated";
        const time = el(
          "time",
          "",
          new Date(event.created_at).toLocaleString(),
        );
        time.dateTime = event.created_at;
        row.append(el("span", "", message), time);
        list.append(row);
      }
    } catch (e) {
      list.textContent = e.message;
    }
  });
  if (editable) {
    const remove = el("details", "detail-section");
    remove.append(el("summary", "danger", "Delete task"));
    remove.append(
      el(
        "p",
        "detail-summary",
        "Deletion is permanent. Tasks with dependents cannot be deleted. Cancel a task to keep its context.",
      ),
    );
    const del = button(
      "Permanently delete task",
      "secondary danger",
      async () => {
        del.disabled = true;
        try {
          await api(`/tasks/${id}`, { method: "DELETE" });
          closeDialog(dialog);
          await refresh();
          notify("Task deleted.");
        } catch (e) {
          err.textContent = e.message;
        } finally {
          del.disabled = false;
        }
      },
    );
    remove.append(del);
    root.append(remove);
  }
  if (editable) title.focus();
  else dialog.querySelector(".close-dialog").focus();
}
setInterval(() => {
  if (!document.hidden) refresh();
}, 7000);
setInterval(async () => {
  for (const [id, token] of owned) {
    try {
      await send(`/tasks/${id}/heartbeat`, "POST", { claim_token: token });
    } catch (e) {
      owned.delete(id);
      notify(`Couldn't renew a claim: ${e.message}`);
      await refresh();
    }
  }
}, 60000);
load();

$("#task-dialog").addEventListener("close", () => {
  const target = document.querySelector(
    `#${state.view} [data-task-id="${state.selected}"]`,
  );
  (target || $("#capture")).focus();
});
