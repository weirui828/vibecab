import { useCallback, useEffect, useState } from "react";
import { Alert, Button } from "@wei/design-system";
import { terms } from "./copy/terms.js";
import type { ConnectionState } from "./connection.js";
import { webBridge } from "./bridge/webBridge.js";
import type { WebBridge } from "./bridge/webBridge.js";
import { LiveStoreProvider } from "./live/LiveStore.js";
import { useWorkspace } from "./live/workspace.js";
import { ToastProvider } from "./ui/Toast.js";
import { GondolaDefs } from "./ui/Gondola.js";
import { PageBoundary } from "./ui/PageBoundary.js";
import { useRoute, useTheme } from "./shell/prefs.js";
import { TopBar, homeRoutes, pageName } from "./shell/TopBar.js";
import type { BarProps } from "./shell/TopBar.js";
import { WindProvider } from "./shell/wind.js";
import { DialogHost } from "./home/DialogHost.js";
import { HomeView, LaterView, NeedsYouView, PageSkeleton } from "./home/Views.js";
import { SessionView, parseSessionRoute } from "./session/SessionView.js";
import { SettingsView } from "./settings/SettingsView.js";
import { FirstRun } from "./settings/FirstRun.js";
import type { SettingsShape } from "./settings/ModelForm.js";
import { useLiveQuery } from "./live/LiveStore.js";
import { TrashView } from "./home/TrashView.js";
import { ProjectView, ProjectsView } from "./home/IdeasProjects.js";
import { SessionsView } from "./home/SessionsView.js";

type Access = "checking" | "ready";

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
    [theme, setTheme] = useTheme();
  const check = useCallback(async () => {
    try {
      const state = await bridge.app.state();
      setConnection(state.connection);
      setAccess("ready");
    } catch {
      setConnection("Engine unreachable");
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
  return (
    <LiveStoreProvider bridge={bridge}>
      <ToastProvider>
        <WindProvider>
          <Shell
            connection={connection}
            ready={access === "ready" && connection === "Connected"}
            theme={theme}
            setTheme={setTheme}
            onRestart={() => void restart()}
          />
        </WindProvider>
      </ToastProvider>
    </LiveStoreProvider>
  );
}

function Shell({
  connection,
  ready,
  theme,
  setTheme,
  onRestart,
}: Pick<BarProps, "connection" | "theme" | "setTheme"> & {
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
    [firstRun, setFirstRun] = useState<"unknown" | "show" | "hide">("unknown");
  // Decided once, when everything has loaded: saving a model during the first run must not end it halfway.
  useEffect(() => {
    if (firstRun !== "unknown" || !settings.data || !workspace.sessions || !workspace.drafts) return;
    const empty =
      Object.keys(settings.data.models ?? {}).length === 0 &&
      workspace.sessions.length === 0 &&
      workspace.drafts.length === 0;
    setFirstRun(empty ? "show" : "hide");
  }, [firstRun, settings.data, workspace.sessions, workspace.drafts]);
  const sessionRoute = parseSessionRoute(route),
    session = sessionRoute ? workspace.sessions?.find((s) => s.sessionId === sessionRoute.sessionId) : undefined;
  let page;
  if (!ready) page = <PageSkeleton />;
  else if (route === "/needs-you") page = <NeedsYouView workspace={workspace} />;
  else if (route === "/drafts") page = <HomeView workspace={workspace} tab="drafts" />;
  else if (route === "/sessions") page = <SessionsView workspace={workspace} />;
  else if (route === "/sessions/ended") page = <SessionsView workspace={workspace} show="ended" key="ended" />;
  else if (sessionRoute)
    page = session ? (
      <SessionView session={session} {...(sessionRoute.artifactId ? { artifactId: sessionRoute.artifactId } : {})} />
    ) : workspace.sessions ? (
      <LaterView title={`${terms.session} not found`} line="It may have been moved to Trash." />
    ) : (
      <PageSkeleton />
    );
  else if (route === "/settings" || route.startsWith("/settings/"))
    page = (
      <SettingsView
        tab={route.slice("/settings/".length)}
        sessions={workspace.sessions ?? []}
        theme={theme}
        setTheme={setTheme}
      />
    );
  else if (route === "/trash") page = <TrashView />;
  else if (route === "/ideas") page = <HomeView workspace={workspace} tab="ideas" />;
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
          title={connection === "Engine stopped" ? "The engine is stopped." : "VibeCab cannot connect to the engine."}
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
        <GondolaDefs />
        <TopBar
          route={route}
          here={session?.title ?? pageName(route) ?? (route.startsWith("/p/") ? terms.project : undefined)}
          sessions={workspace.sessions}
          drafts={workspace.drafts}
          attention={workspace.attention}
          connection={connection}
          theme={theme}
          setTheme={setTheme}
        />
        <main className="vc-main">
          {banner}
          {/* Home's tabs are one page: moving between them must not start it again. */}
          <PageBoundary key={homeRoutes.includes(route) ? "/" : route}>{page}</PageBoundary>
        </main>
      </div>
    </DialogHost>
  );
}
