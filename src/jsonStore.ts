/**
 * Port of `utils.py` JSON persistence (`json_load` / `json_save` /
 * `merge_json` plus the tagged-value `_serialize` / `_deserialize` pair).
 *
 * The on-disk format is byte-compatible with the Python implementation:
 * tagged values look like `{"__type": "set", "data": [...]}` and atomic
 * saves still go through `<name>.new` + rename. A Docker `/data` volume
 * written by the Python miner can be read by this module and vice versa.
 *
 * Deviations from Python (all intentional, documented):
 * - `structuredClone` deep-copies `defaults`; Python's `dict(defaults)` is
 *   a shallow copy that shares nested mutables.
 * - JS has a single `number` type, so `mergeJson` cannot distinguish Python
 *   `int` vs `float` (both stay). `boolean` vs `number` is still distinct,
 *   matching Python's strict `type(v) is type(template[k])` check.
 * - `Date` has no naive/tz-aware split; serialization always stores UTC
 *   seconds since the epoch, exactly like `datetime.timestamp()`.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { PriorityMode } from "./twitchProtocol.ts";

export { PriorityMode };

export interface TaggedValue {
  __type: string;
  data: unknown;
}

/** Sentinel for values whose `__type` is unknown (Python's `_MISSING`). */
const MISSING: unique symbol = Symbol("jsonStore.missing");
type Missing = typeof MISSING;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Serialize one value to its tagged JSON form. Throws `TypeError` otherwise.
 *
 * NOTE: a `PriorityMode` member is a plain number at runtime and passes
 * through untagged (lossless in TS, since the enum *is* a number). Callers
 * that write files Python will read (e.g. `settings.json`) must wrap enum
 * members with `serializePriorityMode` so Python revives them as members.
 */
export function serializeValue(value: unknown): unknown {
  if (value instanceof Date) {
    return { __type: "datetime", data: value.getTime() / 1000 };
  }
  if (value instanceof Set) {
    return { __type: "set", data: [...value].map(serializeValue) };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeValue(v);
    return out;
  }
  throw new TypeError(`Cannot serialize value of type ${typeof value}`);
}

/** Explicitly tag a `PriorityMode` member (plain numbers stay untagged). */
export function serializePriorityMode(mode: PriorityMode): TaggedValue {
  return { __type: "PriorityMode", data: mode as number };
}

/** Explicitly tag a URL string (yarl `URL` serializes via `str(url)`). */
export function serializeUrl(url: string): TaggedValue {
  return { __type: "URL", data: url };
}

/** Explicitly tag a `Set` (used when the static type is not visible). */
export function serializeSet(values: Iterable<unknown>): TaggedValue {
  return { __type: "set", data: [...values].map(serializeValue) };
}

/** Revive one parsed JSON value. Unknown `__type`s become `MISSING`. */
function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (!isPlainObject(value)) return value;
  const revivedEntries = Object.entries(value).map(([k, v]): [string, unknown] => [k, revive(v)]);
  const obj: Record<string, unknown> = Object.fromEntries(revivedEntries);
  if (typeof obj["__type"] !== "string") return obj;
  switch (obj["__type"] as string) {
    case "set":
      return new Set(Array.isArray(obj["data"]) ? (obj["data"] as unknown[]) : []);
    case "URL":
      return typeof obj["data"] === "string" ? obj["data"] : (MISSING as unknown as Missing);
    case "PriorityMode": {
      const n = obj["data"];
      return typeof n === "number" && n in PriorityMode ? (n as PriorityMode) : (MISSING as unknown as Missing);
    }
    case "datetime": {
      const seconds = obj["data"];
      if (typeof seconds !== "number" || !Number.isFinite(seconds)) return MISSING as unknown as Missing;
      return new Date(seconds * 1000);
    }
    default:
      return MISSING as unknown as Missing;
  }
}

/**
 * Drop `MISSING` values in place; dicts left empty by pruning are removed
 * too. Faithful port of `_remove_missing` (including in-place mutation).
 */
export function removeMissing<T>(obj: T): T {
  if (Array.isArray(obj)) {
    for (const item of obj) removeMissing(item);
    return obj;
  }
  if (!isPlainObject(obj)) return obj;
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value === (MISSING as unknown)) {
      delete record[key];
    } else if (isPlainObject(value)) {
      removeMissing(value);
      if (Object.keys(value).length === 0) delete record[key];
    } else if (Array.isArray(value)) {
      for (const item of value) removeMissing(item);
    }
  }
  return obj;
}

function jsonKind(value: unknown): string {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "str";
  if (isPlainObject(value)) return "dict";
  if (value instanceof Set) return "set";
  if (value instanceof Date) return "datetime";
  return typeof value;
}

/**
 * Merge `obj` against `template` in place: unknown keys are dropped,
 * type mismatches reset to the template value, missing keys are filled.
 * Faithful port of `merge_json`.
 */
export function mergeJson(obj: Record<string, unknown>, template: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (!(key in template)) {
      delete obj[key];
    } else if (jsonKind(obj[key]) !== jsonKind(template[key])) {
      obj[key] = template[key];
    } else if (isPlainObject(obj[key]) && isPlainObject(template[key])) {
      mergeJson(obj[key] as Record<string, unknown>, template[key] as Record<string, unknown>);
    }
  }
  for (const key of Object.keys(template)) {
    if (!(key in obj)) obj[key] = template[key];
  }
}

function readJsonFile(path: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    return removeMissing(revive(parsed) as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Load a JSON settings/stats file with `<name>.new` crash-recovery and
 * defaults merging. Faithful port of `json_load`.
 */
export function jsonLoad<T extends Record<string, unknown>>(
  path: string,
  defaults: T,
  merge = true,
): T {
  const freshPath = `${path}.new`;
  let combined: Record<string, unknown> | null = null;
  if (existsSync(freshPath)) {
    combined = readJsonFile(freshPath);
    if (combined === null) {
      try {
        unlinkSync(freshPath);
      } catch {
        // Best effort; the next save overwrites it.
      }
    }
  }
  if (combined === null && existsSync(path)) {
    combined = readJsonFile(path);
  }
  if (combined === null) {
    return structuredClone(defaults);
  }
  if (merge) {
    mergeJson(combined, structuredClone(defaults) as Record<string, unknown>);
  }
  return combined as T;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

/**
 * Atomically save JSON via `<name>.new` + rename. Faithful port of
 * `json_save` (indent 4, optional recursive key sort like `sort_keys`).
 */
export function jsonSave(path: string, contents: Record<string, unknown>, sort = false): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload = sort ? sortKeys(structuredClone(contents)) : structuredClone(contents);
  const encoded = (function encode(value: unknown): unknown {
    if (value instanceof Date) return { __type: "datetime", data: value.getTime() / 1000 };
    if (value instanceof Set) return { __type: "set", data: [...value].map(encode) };
    if (Array.isArray(value)) return value.map(encode);
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = encode(v);
      return out;
    }
    return value;
  })(payload);
  writeFileSync(`${path}.new`, JSON.stringify(encoded, null, 4), "utf8");
  renameSync(`${path}.new`, path);
}
