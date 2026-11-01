import type { Element } from "../../../../contract/generated/index.js";

export type Selected = {
  element: Element;
  locator?: { quote: string; prefix: string; suffix: string };
  /** "block" = the whole piece was chosen; "range" = text inside it was selected. */
  source?: "block" | "range";
};
