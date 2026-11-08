import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Icon, IconButton } from "@wei/design-system";
import { terms } from "../../ui/src/copy/terms.js";
import type { ConnectionState } from "../../ui/src/connection.js";
import { BridgeError, webBridge } from "./bridge/webBridge.js";
import type { WebBridge } from "./bridge/webBridge.js";
import { LiveStoreProvider } from "./live/LiveStore.js";
import { useWorkspace } from "./live/workspace.js";
import { ToastProvider } from "./ui/Toast.js";
import { Mark, Wordmark } from "./ui/Brand.js";
import { useRoute, useTheme } from "./shell/prefs.js";
import { Sidebar } from "./shell/Navigation.js";
import type { NavProps } from "./shell/Navigation.js";
import { DialogHost } from "./home/DialogHost.js";
import { DraftsView, HomeView, LaterView, NeedsYouView, PageSkeleton } from "./home/Views.js";
import { SessionView, parseSessionRoute } from "./session/SessionView.js";
import { SettingsView } from "./settings/SettingsView.js";
import { FirstRun } from "./settings/FirstRun.js";
import type { SettingsShape } from "./settings/ModelForm.js";
import { useLiveQuery } from "./live/LiveStore.js";
import { TrashView } from "./home/TrashView.js";
import { IdeasView, ProjectView, ProjectsView } from "./home/IdeasProjects.js";

type Access = "checking" | "signed-out" | "ready";

// Per-browser flags; storage can be unavailable (private windows), and everything still works without it.
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeFlag(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // ignore
  }
}

// One bridge for the page's lifetime: a new one per render would reset every live query and the event stream.
let pageBridge: WebBridge | undefined;
const defaultBridge = () => (pageBridge ??= webBridge());

export function App({ bridge = defaultBridge() }: { bridge?: WebBridge }) {
  const [access, setAccess] = useState<Access>("checking"),
    [connection, setConnection] = useState<ConnectionState>("Starting"),
    [version, setVersion] = useState("0.1.0"),
    [theme, setTheme] = useTheme();
  const check = useCallback(async () => {
    try {
      const state = await bridge.app.state();
      setConnection(state.connection);
      setVersion(state.version);
      setAccess("ready");
    } catch (error) {
      if (error instanceof BridgeError && error.error.code === "unauthenticated") setAccess("signed-out");
      else setConnection("Engine unreachable");
    }
  }, [bridge]);
  useEffect(() => {
    void check();
    const timer = setInterval(() => void check(), 15_000),
      onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [check]);
  const restart = useCallback(async () => {
    setConnection("Starting");
    try {
      setConnection(await bridge.app.startEngine());
    } catch {
      setConnection("Engine unreachable");
    }
  }, [bridge]);
  if (access === "signed-out") return <SignedOut />;
  return (
    <LiveStoreProvider bridge={bridge}>
      <ToastProvider>
        <Shell
          connection={connection}
          ready={access === "ready" && connection === "Connected"}
          theme={theme}
          setTheme={setTheme}
          version={version}
          onRestart={() => void restart()}
        />
      </ToastProvider>
    </LiveStoreProvider>
  );
}

function Shell({
  connection,
  ready,
  theme,
  setTheme,
  version,
  onRestart,
}: Pick<NavProps, "connection" | "theme" | "setTheme" | "version"> & {
  ready: boolean;
  onRestart(): void;
}) {
  const route = useRoute(),
    workspace = useWorkspace(ready),
    settings = useLiveQuery<SettingsShape>("sys.Settings", {}, ready),
    [firstRunDone, setFirstRunDone] = useState(() => readFlag("vc-first-run-done")),
    finishFirstRun = useCallback(() => {
      writeFlag("vc-first-run-done");
      setFirstRunDone(true);
    }, []),
    [firstRun, setFirstRun] = useState<"unknown" | "show" | "hide">("unknown"),
    sheet = useRef<HTMLDialogElement>(null);
  const needsYou = useMemo(
    () => [...workspace.attention.values()].filter((items) => items.length > 0).length,
    [workspace.attention],
  );
  useEffect(() => sheet.current?.close?.(), [route]);
  // Decided once, when everything has loaded: saving a model during the first run must not end it halfway.
  useEffect(() => {
    if (firstRun !== "unknown" || !settings.data || !workspace.sessions || !workspace.drafts) return;
    const empty = !settings.data.models?.default && workspace.sessions.length === 0 && workspace.drafts.length === 0;
    setFirstRun(empty ? "show" : "hide");
  }, [firstRun, settings.data, workspace.sessions, workspace.drafts]);
  const nav: NavProps = {
    route,
    sessions: workspace.sessions,
    attention: workspace.attention,
    needsYou,
    connection,
    theme,
    setTheme,
    version,
  };
  const sessionRoute = parseSessionRoute(route),
    session = sessionRoute ? workspace.sessions?.find((s) => s.sessionId === sessionRoute.sessionId) : undefined;
  let page;
  if (!ready) page = <PageSkeleton />;
  else if (route === "/needs-you") page = <NeedsYouView workspace={workspace} />;
  else if (route === "/drafts") page = <DraftsView workspace={workspace} />;
  else if (sessionRoute)
    page = session ? (
      <SessionView session={session} {...(sessionRoute.artifactId ? { artifactId: sessionRoute.artifactId } : {})} />
    ) : workspace.sessions ? (
      <LaterView title={`${terms.session} not found`} line="It may have been moved to Trash." />
    ) : (
      <PageSkeleton />
    );
  else if (route === "/settings")
    page = <SettingsView sessions={workspace.sessions ?? []} theme={theme} setTheme={setTheme} />;
  else if (route === "/trash") page = <TrashView />;
  else if (route === "/ideas") page = <IdeasView sessions={workspace.sessions ?? []} />;
  else if (route === "/projects") page = <ProjectsView />;
  else if (route.startsWith("/p/"))
    page = (
      <ProjectView projectId={route.slice(3)} sessions={workspace.sessions ?? []} drafts={workspace.drafts ?? []} />
    );
  else if (firstRun === "show" && !firstRunDone) page = <FirstRun onDone={finishFirstRun} />;
  else page = <HomeView workspace={workspace} />;
  const banner =
    connection === "Engine stopped" || connection === "Engine unreachable" ? (
      <div className="vc-page" style={{ paddingBottom: 0 }}>
        <Alert
          className="vc-banner"
          tone="warning"
          title={connection === "Engine stopped" ? "The engine is stopped." : "Can’t reach the engine."}
          actions={
            <Button size="sm" variant="secondary" onClick={onRestart}>
              {connection === "Engine stopped" ? "Start engine" : "Try again"}
            </Button>
          }
        >
          Your work is safe on this computer. Start it again to keep going.
        </Alert>
      </div>
    ) : null;
  return (
    <DialogHost sessions={workspace.sessions ?? []} drafts={workspace.drafts ?? []}>
      <div className="vc-app">
        <Sidebar {...nav} />
        <dialog
          ref={sheet}
          className="vc-sheet"
          aria-label="Navigation"
          onClick={(e) => e.target === sheet.current && sheet.current?.close()}
        >
          <Sidebar {...nav} onNavigate={() => sheet.current?.close()} />
        </dialog>
        <main className="vc-main">
          <div className="vc-mobilebar">
            <a href="#/" aria-label="Home" style={{ display: "inline-flex" }}>
              <Wordmark height={24} />
            </a>
            <IconButton
              variant="ghost"
              label="Menu"
              icon={<Icon name="bars-3" size={20} />}
              onClick={() => sheet.current?.showModal?.()}
            />
          </div>
          {banner}
          {page}
        </main>
      </div>
    </DialogHost>
  );
}

function SignedOut() {
  return (
    <div className="vc-gate">
      <div className="inner">
        <Mark height={36} />
        <h1 className="vc-display" style={{ fontSize: 34, marginTop: 12 }}>
          Sign in this browser
        </h1>
        <p className="vc-muted" style={{ margin: 0 }}>
          This browser isn't signed in yet. For your safety, each browser signs in once with a one-time link, so nothing
          else on this computer can use VibeCab as you.
        </p>
        <p className="vc-muted" style={{ margin: 0 }}>
          Open the link printed where VibeCab started, or get a new one while it runs:
        </p>
        <code>node apps/web/bin/vibecab-web.mjs link</code>
        <p className="vc-muted small" style={{ margin: 0 }}>
          Not running? Start it with <code>pnpm web</code>.
        </p>
      </div>
    </div>
  );
}
