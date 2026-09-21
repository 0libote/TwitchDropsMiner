/**
 * Tests for `src/jsonStore.ts`, mirroring `utils.py` persistence semantics.
 * The `PYTHON_FIXTURE` string below was produced by the real Python
 * implementation (`json.dumps(sample, default=_serialize, sort_keys=True,
 * indent=4)`), so the tagged-format test proves byte-compatibility.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PriorityMode, jsonLoad, jsonSave, mergeJson, serializePriorityMode, serializeSet, serializeUrl, serializeValue } from "./jsonStore.ts";

const PYTHON_FIXTURE = `{
    "count": 3,
    "exclude": {
        "__type": "set",
        "data": [
            "Game B"
        ]
    },
    "priority": [
        "Game A"
    ],
    "priority_mode": {
        "__type": "PriorityMode",
        "data": 1
    },
    "proxy": {
        "__type": "URL",
        "data": "http://localhost:3128"
    },
    "when": {
        "__type": "datetime",
        "data": 1704164645.0
    }
}`;

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "tdm-json-")), name);
}

/** Load an already-stringified payload through the revive+prune path. */
function loadStringified(raw: string): Record<string, unknown> {
  const path = tempPath("obj.json");
  writeFileSync(path, raw, "utf8");
  return jsonLoad(path, {}, false);
}

describe("tagged values", () => {
  test("reads the exact format Python writes", () => {
    const revived = loadStringified(PYTHON_FIXTURE);
    expect(revived["count"]).toBe(3);
    expect(revived["exclude"]).toEqual(new Set(["Game B"]));
    expect(revived["priority"]).toEqual(["Game A"]);
    expect(revived["priority_mode"]).toBe(PriorityMode.ENDING_SOONEST);
    expect(revived["proxy"]).toBe("http://localhost:3128");
    expect((revived["when"] as Date).toISOString()).toBe("2024-01-02T03:04:05.000Z");
  });

  test("round-trips set/URL/enum/datetime through save+load", () => {
    const path = tempPath("round.json");
    const when = new Date("2024-05-06T07:08:09.000Z");
    jsonSave(path, {
      tags: serializeSet(["a", "b"]),
      proxy: serializeUrl("http://localhost:3128"),
      mode: serializePriorityMode(PriorityMode.LOW_AVBL_FIRST),
      when: serializeValue(when),
      plain: 1,
    });
    const loaded = jsonLoad(path, {}, false) as Record<string, unknown>;
    expect(loaded["tags"]).toEqual(new Set(["a", "b"]));
    expect(loaded["proxy"]).toBe("http://localhost:3128");
    expect(loaded["mode"]).toBe(PriorityMode.LOW_AVBL_FIRST);
    expect((loaded["when"] as Date).getTime()).toBe(when.getTime());
    expect(loaded["plain"]).toBe(1);
  });

  test("unknown __type values are pruned, emptied parents removed", () => {
    const cleaned = loadStringified(JSON.stringify({
      keep: 1,
      dropped: { __type: "FutureThing", data: 1 },
      nested: { inner: { __type: "Nope", data: [] } },
    }));
    expect(cleaned).toEqual({ keep: 1 });
  });

  test("serializeValue rejects unserializable input", () => {
    expect(() => serializeValue(Symbol("x"))).toThrow(TypeError);
    expect(() => serializeValue(() => {})).toThrow(TypeError);
  });
});

describe("mergeJson", () => {
  test("drops unknown keys, fills missing, resets type mismatches", () => {
    const obj: Record<string, unknown> = { a: 1, stale: true, mode: "nope", nested: { x: 1, y: 2 } };
    mergeJson(obj, { a: 0, mode: 1, nested: { x: 0 }, fresh: "d" });
    expect(obj).toEqual({ a: 1, mode: 1, nested: { x: 1 }, fresh: "d" });
  });

  test("distinguishes boolean from number like Python type() checks", () => {
    const obj: Record<string, unknown> = { flag: 1 };
    mergeJson(obj, { flag: true });
    expect(obj["flag"]).toBe(true);
  });
});

describe("jsonLoad/jsonSave", () => {
  test("missing file returns a copy of defaults", () => {
    const defaults = { list: ["x"], n: 1 };
    const loaded = jsonLoad(tempPath("missing.json"), defaults);
    expect(loaded).toEqual(defaults);
    expect(loaded["list"]).not.toBe(defaults["list"]);
  });

  test("corrupt .new file is deleted and the old file wins", () => {
    const path = tempPath("recover.json");
    jsonSave(path, { v: 2 });
    writeFileSync(`${path}.new`, "{not json", "utf8");
    const loaded = jsonLoad(path, { v: 0 });
    expect(loaded).toEqual({ v: 2 });
    expect(existsSync(`${path}.new`)).toBe(false);
  });

  test("save is atomic and sorted when asked", () => {
    const path = tempPath("sorted.json");
    jsonSave(path, { b: 1, a: 2 }, true);
    expect(existsSync(`${path}.new`)).toBe(false);
    const raw = readFileSync(path, "utf8");
    expect(raw.indexOf('"a"')).toBeLessThan(raw.indexOf('"b"'));
    expect(JSON.parse(raw)).toEqual({ a: 2, b: 1 });
  });
});
