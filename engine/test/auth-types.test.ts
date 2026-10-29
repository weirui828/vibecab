import { it, expect } from "vitest";
import type { CallAuth, CallMetadata } from "../src/engine.js";

const validCredential: CallAuth = { kind: "token", secret: "random-secret", transport: "http" };
const validMetadata: CallMetadata = { contractVersion: "1.0", requestId: "request" };
// @ts-expect-error Adapters cannot choose the authority scope.
const forgedScope: CallAuth = { kind: "token", secret: "random-secret", transport: "http", scope: "admin" };
// @ts-expect-error Adapters cannot choose the resolved channel.
const forgedChannel: CallMetadata = { contractVersion: "1.0", requestId: "request", channel: "in_process" };

it("keeps adapter credentials and request metadata separate from resolved authority", () => {
  expect(validCredential).toEqual({ kind: "token", secret: "random-secret", transport: "http" });
  expect(validMetadata).toEqual({ contractVersion: "1.0", requestId: "request" });
  expect(forgedScope).toMatchObject({ scope: "admin" });
  expect(forgedChannel).toMatchObject({ channel: "in_process" });
});
