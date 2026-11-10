import { expect, it } from "vitest";
import { eventScript, external, insideApp, navigateScript } from "../src/shell-page.js";

it("navigates only to pages of the app, with the path quoted", () => {
  expect(navigateScript("/settings")).toBe('window.location.hash = "#/settings";');
  expect(navigateScript("/s/session_01ABC")).toBe('window.location.hash = "#/s/session_01ABC";');
  for (const bad of ['/x";alert(1);"', "https://example.com", "settings", "/a b", "/a\nb"])
    expect(() => navigateScript(bad)).toThrow();
});

it("tells the page about a menu action as a window event", () => {
  expect(eventScript("new-draft")).toBe('window.dispatchEvent(new CustomEvent("vibecab:new-draft"));');
});

it("keeps the window on the web host it started, and hands only https and mailto links to the system", () => {
  const app = "http://127.0.0.1:5165";
  expect(insideApp("http://127.0.0.1:5165/#/settings", app)).toBe(true);
  expect(insideApp("http://127.0.0.1:5166/", app)).toBe(false);
  expect(insideApp("http://localhost:5165/", app)).toBe(false);
  expect(insideApp("https://example.com/", app)).toBe(false);
  expect(insideApp("not a url", app)).toBe(false);
  expect(external("https://example.com")).toBe(true);
  expect(external("mailto:a@example.com")).toBe(true);
  expect(external("http://example.com")).toBe(false);
  expect(external("file:///etc/passwd")).toBe(false);
  expect(external("javascript:alert(1)")).toBe(false);
});
