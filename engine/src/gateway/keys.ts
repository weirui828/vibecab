import { Entry } from "@napi-rs/keyring";
import { fail } from "../../../contract/src/index.js";
import type { KeyStore } from "./types.js";

export class NativeKeyStore implements KeyStore {
  async get(ref: string): Promise<string> {
    try {
      const value = new Entry("VibeCab", ref).getPassword();
      if (value === null)
        fail("not_found", "Provider key reference was not found");
      return value;
    } catch (error) {
      if (error instanceof Error && "contract" in error) throw error;
      fail("not_found", "Provider key reference was not found");
    }
  }
  async set(ref: string, secret: string): Promise<void> {
    try {
      new Entry("VibeCab", ref).setPassword(secret);
    } catch {
      fail("unavailable", "Could not store provider key in the OS keychain");
    }
  }
  async delete(ref: string): Promise<void> {
    try {
      new Entry("VibeCab", ref).deletePassword();
    } catch {
      fail("not_found", "Provider key reference was not found");
    }
  }
}

export class MemoryKeyStore implements KeyStore {
  private readonly secrets = new Map<string, string>();
  async get(ref: string): Promise<string> {
    const secret = this.secrets.get(ref);
    if (secret === undefined)
      fail("not_found", "Provider key reference was not found");
    return secret;
  }
  async set(ref: string, secret: string): Promise<void> {
    this.secrets.set(ref, secret);
  }
  async delete(ref: string): Promise<void> {
    if (!this.secrets.delete(ref))
      fail("not_found", "Provider key reference was not found");
  }
}
