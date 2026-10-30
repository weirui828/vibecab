import type { Element } from "../../../../contract/generated/index.js";

export type Selected = { element: Element; locator?: { quote: string; prefix: string; suffix: string } };
