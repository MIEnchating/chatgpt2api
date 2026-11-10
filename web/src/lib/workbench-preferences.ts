import type { CreationWorkbenchPreferences, ImageWorkbenchSettings, VideoWorkbenchSettings } from "./api";

export function imageWorkbenchSettings(value: CreationWorkbenchPreferences): ImageWorkbenchSettings {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key.startsWith("image_") && key !== "image_model")) as ImageWorkbenchSettings;
}

export function videoWorkbenchSettings(value: CreationWorkbenchPreferences): VideoWorkbenchSettings {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key.startsWith("video_") && key !== "video_model")) as VideoWorkbenchSettings;
}

export function workbenchPreferenceKey(value: CreationWorkbenchPreferences) {
  return `${value.composer_mode}:${value.composer_mode === "video" ? value.video_model : value.image_model}`;
}

export function workbenchPreferenceSignature(value: CreationWorkbenchPreferences) {
  return JSON.stringify([workbenchPreferenceKey(value), value.smart_context_enabled, value.context_text_model, value.composer_mode === "video" ? videoWorkbenchSettings(value) : imageWorkbenchSettings(value)]);
}

// Keep one latest snapshot per model, and serialize writes so slow requests cannot
// overwrite newer settings. Failed snapshots remain queued until an explicit retry.
export class WorkbenchPreferenceSaver {
  private pending = new Map<string, CreationWorkbenchPreferences>();
  private running = false;
  private paused = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private latestGlobal = { smart_context_enabled: false, context_text_model: "" };

  constructor(private save: (value: CreationWorkbenchPreferences) => Promise<void>, private onError: (error: unknown) => void) {}

  get unsaved() { return this.running || this.pending.size > 0; }

  enqueue(value: CreationWorkbenchPreferences) {
    if (this.stopped) return;
    this.latestGlobal = { smart_context_enabled: value.smart_context_enabled, context_text_model: value.context_text_model };
    for (const pending of this.pending.values()) {
      pending.smart_context_enabled = value.smart_context_enabled;
      pending.context_text_model = value.context_text_model;
    }
    const key = workbenchPreferenceKey(value);
    this.pending.delete(key);
    this.pending.set(key, structuredClone(value));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 400);
  }

  async flush() {
    clearTimeout(this.timer);
    if (this.running || this.paused || this.stopped) return;
    this.running = true;
    try {
      while (this.pending.size && !this.stopped) {
        const [key, value] = this.pending.entries().next().value!;
        this.pending.delete(key);
        try { await this.save(value); }
        catch (error) {
          if (this.stopped) return;
          Object.assign(value, this.latestGlobal);
          if (!this.pending.has(key)) this.pending = new Map([[key, value], ...this.pending]);
          this.paused = true;
          this.onError(error);
          return;
        }
      }
    } finally { this.running = false; }
  }

  retry() { this.paused = false; return this.flush(); }

  stop() { this.stopped = true; clearTimeout(this.timer); this.pending.clear(); }
}
