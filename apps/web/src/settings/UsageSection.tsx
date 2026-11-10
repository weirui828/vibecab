import { useMemo, useState } from "react";
import { Glider } from "../ui/Glider.js";
import { terms } from "../../../ui/src/copy/terms.js";
import { useLiveQuery } from "../live/LiveStore.js";
import type { SessionRow } from "../live/workspace.js";
import { Section, dollars, useAgentName } from "./common.js";

type Totals = {
  calls: number;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  errors: number;
  medianDurationMs: number;
  p95DurationMs: number;
};
type Stats = { totals: Totals; groups: Array<Totals & { key: string }> };
type Range = 1 | 7 | 30;

const purposeNames: Record<string, string> = {
  reply: "Replies",
  update: `${terms.update}s (writing)`,
  plan: `${terms.update}s (planning)`,
  review: "Settling conflicts",
  digest: "Catch-up summaries",
};

/** Local midnight `days - 1` days ago, through local midnight tomorrow: "today", "7 days", "30 days". */
function periodOf(days: Range, now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)),
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const dayKeys: string[] = [];
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1))
    dayKeys.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    );
  return { from: start.toISOString(), to: end.toISOString(), dayKeys };
}

const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
const money = (micros: number) => "$" + dollars(micros);
const seconds = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const dayLabel = (key: string) =>
  new Date(key + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** Cost per day as thin bars on one baseline, one series; hover or focus shows the day's figures. */
export function CostPerDay({
  days,
}: {
  days: Array<{ key: string; costMicros: number; calls: number; tokens: number }>;
}) {
  const [active, setActive] = useState<string>();
  const top = Math.max(...days.map((d) => d.costMicros), 1);
  return (
    <figure className="vc-usage-chart">
      <figcaption className="vc-label">Cost per day</figcaption>
      <div className="plot" onMouseLeave={() => setActive(undefined)}>
        {days.map((d) => (
          <div
            key={d.key}
            className="col"
            tabIndex={0}
            role="img"
            aria-label={`${dayLabel(d.key)}: ${money(d.costMicros)}, ${d.calls} calls`}
            onMouseEnter={() => setActive(d.key)}
            onFocus={() => setActive(d.key)}
            onBlur={() => setActive(undefined)}
          >
            <span
              className="bar"
              style={{ height: `${d.costMicros > 0 ? Math.max(3, (d.costMicros / top) * 100) : 0}%` }}
            />
            {active === d.key && (
              <span className="vc-tip" role="presentation">
                <strong>{dayLabel(d.key)}</strong>
                <span>{money(d.costMicros)}</span>
                <span>
                  {d.calls} calls · {tokens(d.tokens)} tokens
                </span>
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="axis" aria-hidden="true">
        <span>{dayLabel(days[0]?.key ?? "")}</span>
        {days.length > 1 && <span>{dayLabel(days.at(-1)?.key ?? "")}</span>}
      </div>
      <details className="vc-as-table">
        <summary>As a table</summary>
        <table className="vc-calls">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Cost</th>
              <th scope="col">Calls</th>
              <th scope="col">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.key}>
                <td>{dayLabel(d.key)}</td>
                <td>{money(d.costMicros)}</td>
                <td>{d.calls}</td>
                <td>{tokens(d.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Groups as rows with a small bar for their share of the cost; names come from `name`. */
function Breakdown({
  title,
  column,
  stats,
  name,
  href,
  limit = 6,
}: {
  title: string;
  column: string;
  stats: Stats | undefined;
  name(key: string): string;
  href?(key: string): string | undefined;
  limit?: number;
}) {
  const rows = [...(stats?.groups ?? [])]
    .sort((a, b) => b.costMicros - a.costMicros || b.calls - a.calls)
    .slice(0, limit);
  if (!rows.length) return null;
  const top = Math.max(...rows.map((r) => r.costMicros), 1);
  return (
    <table className="vc-calls vc-breakdown">
      <caption className="vc-label">{title}</caption>
      <thead>
        <tr>
          <th scope="col">{column}</th>
          <th scope="col">Cost</th>
          <th scope="col">Tokens in / out</th>
          <th scope="col">Calls</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const link = href?.(r.key);
          return (
            <tr key={r.key}>
              <td>{link ? <a href={link}>{name(r.key)}</a> : name(r.key)}</td>
              <td>
                <span className="share" aria-hidden="true">
                  <span style={{ width: `${(r.costMicros / top) * 100}%` }} />
                </span>
                {money(r.costMicros)}
              </td>
              <td>
                {tokens(r.inputTokens)} / {tokens(r.outputTokens)}
              </td>
              <td>
                {r.calls}
                {r.errors > 0 && <span className="vc-muted"> · {r.errors} failed</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Usage (W11): what the agents cost, how much they read and wrote, and where it went — from the call records.
 * Agents paid by their own subscription (W12) show tokens and calls; their cost is "subscription".
 */
export function UsageSection({ sessions }: { sessions: SessionRow[] }) {
  const [days, setDays] = useState<Range>(7),
    agentName = useAgentName();
  const span = useMemo(() => periodOf(days), [days]);
  const args = (groupBy: string) => ({ from: span.from, to: span.to, groupBy });
  const byDay = useLiveQuery<Stats>("sys.UsageStats", args("day")),
    byAgent = useLiveQuery<Stats>("sys.UsageStats", args("agent")),
    byModel = useLiveQuery<Stats>("sys.UsageStats", args("model")),
    bySession = useLiveQuery<Stats>("sys.UsageStats", args("session")),
    byPurpose = useLiveQuery<Stats>("sys.UsageStats", args("purpose"));
  const totals = byDay.data?.totals,
    titles = new Map(sessions.map((s) => [s.sessionId, s.title]));
  const perDay = span.dayKeys.map((key) => {
    const g = byDay.data?.groups.find((x) => x.key === key);
    return {
      key,
      costMicros: g?.costMicros ?? 0,
      calls: g?.calls ?? 0,
      tokens: (g?.inputTokens ?? 0) + (g?.outputTokens ?? 0),
    };
  });
  return (
    <Section id="usage" title="Usage" lede="What the agents cost, how much they read and wrote, and where it went.">
      <div className="vc-segmented small" role="group" aria-label="Period">
        <Glider selector='[aria-pressed="true"],[aria-current="page"]' />
        {(
          [
            [1, "Today"],
            [7, "7 days"],
            [30, "30 days"],
          ] as const
        ).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={days === value} onClick={() => setDays(value)}>
            {label}
          </button>
        ))}
      </div>
      <dl className="vc-figures">
        <div>
          <dt>Cost</dt>
          <dd>{money(totals?.costMicros ?? 0)}</dd>
        </div>
        <div>
          <dt>Tokens</dt>
          <dd>{tokens((totals?.inputTokens ?? 0) + (totals?.outputTokens ?? 0))}</dd>
        </div>
        <div>
          <dt>Calls</dt>
          <dd>{totals?.calls ?? 0}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>
            {totals?.calls ? `${Math.round(((totals.errors ?? 0) / totals.calls) * 100)}%` : "—"}
            {totals?.calls ? <span className="vc-facts"> · typical {seconds(totals.medianDurationMs)}</span> : null}
          </dd>
        </div>
      </dl>
      {totals?.calls ? (
        <>
          {/* With nothing charged (local or scripted models), an empty plot would say less than one line. */}
          {days > 1 &&
            (totals.costMicros > 0 ? (
              <CostPerDay days={perDay} />
            ) : (
              <p className="vc-muted small">Nothing was charged in this period.</p>
            ))}
          <Breakdown
            title="By agent"
            column="Agent"
            stats={byAgent.data}
            name={(k) => (k ? agentName(k) : "Before agents were recorded")}
          />
          <Breakdown title="By model" column="Model" stats={byModel.data} name={(k) => k} />
          <Breakdown
            title="By purpose"
            column="For"
            stats={byPurpose.data}
            name={(k) => purposeNames[k] ?? (k || "Not recorded")}
          />
          <Breakdown
            title={`Costliest ${terms.session.toLowerCase()}s`}
            column={terms.session}
            stats={{ totals: totals, groups: (bySession.data?.groups ?? []).filter((g) => g.key) }}
            name={(k) => titles.get(k) ?? (sessions.length ? `A ${terms.session.toLowerCase()} since removed` : "…")}
            href={(k) => (titles.has(k) ? "#/s/" + k : undefined)}
            limit={5}
          />
        </>
      ) : (
        <p className="vc-muted">No model calls in this period.</p>
      )}
    </Section>
  );
}
