/**
 * Port of `settings.py`: typed dashboard/miner preferences persisted as
 * tagged JSON (see `jsonStore.ts`), with CLI-arg overlay.
 *
 * Storage form matches Python exactly: `proxy` is a tagged `URL` string,
 * `exclude` a tagged `set`, `priority_mode` a tagged `PriorityMode`
 * number — so `settings.json` files move freely between runtimes.
 * Unknown keys are pruned and type mismatches reset on load, exactly like
 * `merge_json`. CLI-only flags (`log`, `dump`, debug levels) are overlaid
 * via the `cli` record, mirroring `Settings.__getattr__` arg-first lookup.
 */

import { PriorityMode } from "./twitchProtocol.ts";
import { jsonLoad, jsonSave, serializePriorityMode, serializeSet, serializeUrl } from "./jsonStore.ts";

export const DEFAULT_LANG = "English";

export interface SettingsFile {
  proxy: string;
  language: string;
  dark_mode: boolean;
  exclude: Set<string>;
  priority: string[];
  connection_quality: number;
  tray_notifications: boolean;
  enable_badges_emotes: boolean;
  available_drops_check: boolean;
  priority_mode: PriorityMode;
  webhook_url: string;
}

export const DEFAULT_SETTINGS: SettingsFile = {
  proxy: "",
  priority: [],
  exclude: new Set(),
  dark_mode: false,
  connection_quality: 1,
  language: DEFAULT_LANG,
  tray_notifications: true,
  enable_badges_emotes: false,
  available_drops_check: false,
  priority_mode: PriorityMode.ENDING_SOONEST,
  webhook_url: "",
};

type StorageForm = Record<string, unknown>;

function toStorageForm(settings: SettingsFile): StorageForm {
  return {
    ...structuredClone({ ...settings, exclude: [...settings.exclude], priority: [...settings.priority] }),
    proxy: serializeUrl(settings.proxy),
    exclude: serializeSet(settings.exclude),
    priority_mode: serializePriorityMode(settings.priority_mode),
  };
}

function fromStorageForm(raw: StorageForm): SettingsFile {
  const pick = <K extends keyof SettingsFile>(key: K, fallback: SettingsFile[K]): SettingsFile[K] => {
    const value = raw[key as string];
    return (value === undefined ? fallback : value) as SettingsFile[K];
  };
  const proxy = pick("proxy", "");
  const exclude = pick("exclude", new Set<string>());
  const mode = pick("priority_mode", PriorityMode.ENDING_SOONEST);
  return {
    proxy: typeof proxy === "string" ? proxy : "",
    language: String(pick("language", DEFAULT_LANG)),
    dark_mode: Boolean(pick("dark_mode", false)),
    exclude: exclude instanceof Set ? new Set([...exclude].filter((g) => typeof g === "string")) : new Set<string>(),
    priority: (Array.isArray(pick("priority", [])) ? (pick("priority", []) as unknown[]) : []).filter(
      (g): g is string => typeof g === "string",
    ),
    connection_quality: Number(pick("connection_quality", 1)),
    tray_notifications: Boolean(pick("tray_notifications", true)),
    enable_badges_emotes: Boolean(pick("enable_badges_emotes", false)),
    available_drops_check: Boolean(pick("available_drops_check", false)),
    priority_mode: typeof mode === "number" && mode in PriorityMode ? (mode as PriorityMode) : PriorityMode.ENDING_SOONEST,
    webhook_url: String(pick("webhook_url", "")),
  };
}

export class Settings {
  private readonly file: SettingsFile;
  private altered = false;

  constructor(
    private readonly dataPath: string,
    private readonly cli: Record<string, unknown> = {},
  ) {
    // Merge against *revived* defaults: jsonLoad revives file values first,
    // so the template must hold live Set/enum values (like Python's
    // `default_settings`), not tagged storage forms.
    const raw = jsonLoad(dataPath, {
      ...DEFAULT_SETTINGS,
      exclude: new Set(DEFAULT_SETTINGS.exclude),
      priority: [...DEFAULT_SETTINGS.priority],
    });
    this.file = fromStorageForm(raw as StorageForm);
  }

  /** CLI args win over the file, mirroring `__getattr__` lookup order. */
  get(name: string): unknown {
    if (name in this.cli) return this.cli[name];
    if (name in this.file) return this.file[name as keyof SettingsFile];
    throw new TypeError(`${name} is not a known setting`);
  }

  set<K extends keyof SettingsFile>(name: K, value: SettingsFile[K]): void {
    if (!(name in this.file)) throw new TypeError(`${name} is missing a custom setter`);
    this.file[name] = value;
    this.altered = true;
  }

  snapshot(): SettingsFile {
    return { ...this.file, exclude: new Set(this.file.exclude), priority: [...this.file.priority] };
  }

  save(force = false): void {
    if (this.altered || force) {
      jsonSave(this.dataPath, toStorageForm(this.file), true);
      this.altered = false;
    }
  }
}
