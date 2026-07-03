import type { AppSettings, SettingsLimits } from "../../lib/types.ts";

const MB = 1024 * 1024;
const MP = 1_000_000;

/** Presentational fields for the operator-tunable app settings. Shared by the
 * admin Settings dialog and the first-run setup screen; owns no fetching. */
export function ProcessingSettingsFields({
  value,
  limits,
  onChange,
}: {
  value: AppSettings;
  limits: SettingsLimits;
  onChange: (next: AppSettings) => void;
}) {
  const set = <K extends keyof AppSettings>(key: K, v: AppSettings[K]) =>
    onChange({ ...value, [key]: v });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-text-1">Generate AVIF thumbnails</p>
          <p className="mt-0.5 text-xs text-text-3">
            Smaller images for faster galleries, at the cost of extra processing time. Turn off on
            slow hardware to speed uploads up.
          </p>
        </div>
        <Toggle
          checked={value.generateAvif}
          onChange={(v) => set("generateAvif", v)}
          label="Generate AVIF"
        />
      </div>

      <NumberField
        label="Processing concurrency"
        hint={`How many photos process at once (${limits.uploadConcurrency.min}–${limits.uploadConcurrency.max}). Higher is faster on powerful hardware; lower uses less memory.`}
        value={value.uploadConcurrency}
        min={limits.uploadConcurrency.min}
        max={limits.uploadConcurrency.max}
        onChange={(n) => set("uploadConcurrency", n)}
      />

      <NumberField
        label="Max upload size (MB per photo)"
        hint={`Uploads larger than this are rejected (${Math.round(limits.maxUploadFileSizeBytes.min / MB)}–${Math.round(limits.maxUploadFileSizeBytes.max / MB)} MB).`}
        value={Math.round(value.maxUploadFileSizeBytes / MB)}
        min={Math.round(limits.maxUploadFileSizeBytes.min / MB)}
        max={Math.round(limits.maxUploadFileSizeBytes.max / MB)}
        onChange={(n) => set("maxUploadFileSizeBytes", Math.round(n) * MB)}
      />

      <NumberField
        label="Max image resolution (megapixels)"
        hint={`Images above this pixel count are rejected (${Math.round(limits.maxImagePixels.min / MP)}–${Math.round(limits.maxImagePixels.max / MP)} MP).`}
        value={Math.round(value.maxImagePixels / MP)}
        min={Math.round(limits.maxImagePixels.min / MP)}
        max={Math.round(limits.maxImagePixels.max / MP)}
        onChange={(n) => set("maxImagePixels", Math.round(n) * MP)}
      />
    </div>
  );
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-text-2">{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
        className="w-32 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-text-1 outline-none transition-colors focus:border-line-strong"
      />
      <span className="text-xs text-text-3">{hint}</span>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${
        checked ? "bg-text-1" : "bg-surface-3"
      }`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full shadow-sm transition-[left] ${
          checked ? "left-[22px] bg-invert" : "left-0.5 bg-text-3"
        }`}
      />
    </button>
  );
}
