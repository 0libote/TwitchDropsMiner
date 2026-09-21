/**
 * Tests for `src/settings.ts`, mirroring `settings.py` persistence.
 * Includes a read of `tests/fixtures/settings-python.json`, written by the
 * real Python `json_save` with live `URL`/`set`/enum values.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PriorityMode } from "./twitchProtocol.ts";
import { Settings } from "./settings.ts";

function tempSettingsPath(): string {
  return join(mkdtempSync(join(tmpdir(), "tdm-settings-")), "settings.json");
}

describe("Settings", () => {
  test("missing file yields defaults", () => {
    const settings = new Settings(tempSettingsPath());
    expect(settings.get("priority")).toEqual([]);
    expect(settings.get("exclude")).toEqual(new Set());
    expect(settings.get("priority_mode")).toBe(PriorityMode.ENDING_SOONEST);
    expect(settings.get("connection_quality")).toBe(1);
    expect(settings.get("tray_notifications")).toBe(true);
  });

  test("round-trips tagged URL/set/enum values through real files", () => {
    const path = tempSettingsPath();
    const first = new Settings(path);
    first.set("proxy", "http://localhost:3128");
    first.set("exclude", new Set(["Fortnite"]));
    first.set("priority", ["Just Chatting"]);
    first.set("priority_mode", PriorityMode.LOW_AVBL_FIRST);
    first.set("connection_quality", 2);
    first.save();
    const second = new Settings(path);
    expect(second.get("proxy")).toBe("http://localhost:3128");
    expect(second.get("exclude")).toEqual(new Set(["Fortnite"]));
    expect(second.get("priority")).toEqual(["Just Chatting"]);
    expect(second.get("priority_mode")).toBe(PriorityMode.LOW_AVBL_FIRST);
    expect(second.get("connection_quality")).toBe(2);
  });

  test("reads a settings.json written by Python", () => {
    const settings = new Settings("tests/fixtures/settings-python.json");
    expect(settings.get("proxy")).toBe("http://localhost:3128");
    expect(settings.get("exclude")).toEqual(new Set(["Fortnite"]));
    expect(settings.get("priority_mode")).toBe(PriorityMode.ENDING_SOONEST);
    expect(settings.get("available_drops_check")).toBe(true);
  });

  test("unknown keys are pruned and type mismatches reset", async () => {
    const path = tempSettingsPath();
    const first = new Settings(path);
    first.set("priority", ["Kept"]);
    first.save();
    const raw = JSON.parse(await Bun.file(path).text()) as Record<string, unknown>;
    raw["bogus"] = true;
    raw["connection_quality"] = "fast";
    await Bun.write(path, JSON.stringify(raw));
    const second = new Settings(path);
    expect(second.get("priority")).toEqual(["Kept"]);
    expect(second.get("connection_quality")).toBe(1);
    expect(() => second.get("bogus")).toThrow(TypeError);
  });

  test("CLI args overlay the file and unknown sets throw", () => {
    const settings = new Settings(tempSettingsPath(), { log: true });
    expect(settings.get("log")).toBe(true);
    expect(() => settings.set("nope" as never, true as never)).toThrow(TypeError);
  });

  test("save is a no-op until something changes", async () => {
    const path = tempSettingsPath();
    const settings = new Settings(path);
    settings.save();
    expect(await Bun.file(path).exists()).toBe(false);
    settings.save(true);
    expect(await Bun.file(path).exists()).toBe(true);
  });
});
