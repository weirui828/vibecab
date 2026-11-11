import { Glider } from "../ui/Glider.js";
import type { ConnectionState } from "../connection.js";
import type { SessionRow } from "../live/workspace.js";
import type { AttentionItem } from "../../../../contract/generated/index.js";
import { Mound } from "../ui/Brand.js";
import type { MoundTone } from "../ui/Brand.js";
import { attentionTone } from "../home/attentionText.js";
import type { ThemeChoice } from "./prefs.js";

export function sessionTone(session: SessionRow, items: AttentionItem[] | undefined): MoundTone {
  if (session.state !== "active") return "quiet";
  if (items?.length) return attentionTone(items);
  return "active";
}

export function ConnectionLabel({ state }: { state: ConnectionState }) {
  const tone: MoundTone = state === "Connected" ? "active" : state === "Starting" ? "agent" : "danger";
  return (
    <span className="vc-connection" title={state}>
      <Mound tone={tone} />
      <span className="label">{state === "Connected" ? "Connected" : state}</span>
    </span>
  );
}

export function ThemeSwitch({
  theme,
  setTheme,
  small,
}: {
  theme: ThemeChoice;
  setTheme(t: ThemeChoice): void;
  small?: boolean;
}) {
  const options: Array<[ThemeChoice, string]> = [
    ["auto", "Auto"],
    ["light", "Summer"],
    ["dark", "Polar night"],
  ];
  return (
    <div className={"vc-segmented" + (small ? " small" : "")} role="group" aria-label="Theme">
      <Glider selector='[aria-pressed="true"]' />
      {options.map(([value, label]) => (
        <button key={value} type="button" aria-pressed={theme === value} onClick={() => setTheme(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}
