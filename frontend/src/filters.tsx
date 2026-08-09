import { useQueryParam } from "./router.jsx";

/**
 * Filter controls that live in the URL.
 *
 * Every control here is bound to a query parameter, never to component state.
 * That is the whole contract of the app's chart surfaces: what you see is what
 * the address bar says, so a view can be sent to someone and open identically.
 * A control holding its own state breaks that silently — the chart changes, the
 * URL does not, and the link you share shows something else.
 */

export interface Option {
  value: string;
  label: string;
}

/**
 * A segmented radio group, bound to one query parameter.
 *
 * `aria-pressed` on real buttons rather than a `<select>`: these are two-to-six
 * mutually exclusive choices that should be visible and one click away, and a
 * range picker hidden behind a dropdown is a filter people forget is applied.
 */
export const Segmented = ({
  label,
  param,
  options,
  fallback,
}: {
  label: string;
  param: string;
  options: Option[];
  fallback: string;
}) => {
  const [value, setValue] = useQueryParam(param, fallback);
  return (
    // A real `fieldset`/`legend`, not a `div` with `role="group"`. The native
    // element carries the grouping semantics without an ARIA attribute that can
    // drift from the element it describes — and it is what assistive technology
    // reads first.
    <fieldset className="field">
      <legend className="field__label">{label}</legend>
      <div className="segmented">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => setValue(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
};

/** A dropdown for open-ended or long option sets, bound to one query parameter. */
export const SelectFilter = ({
  label,
  param,
  options,
  fallback,
  anyLabel,
}: {
  label: string;
  param: string;
  options: Option[];
  fallback: string;
  /** Label for the empty choice. Omit to make the field required. */
  anyLabel?: string;
}) => {
  const [value, setValue] = useQueryParam(param, fallback);
  return (
    <div className="field">
      <label className="field__label" htmlFor={`filter-${param}`}>
        {label}
      </label>
      <select id={`filter-${param}`} value={value} onChange={(e) => setValue(e.target.value)}>
        {anyLabel !== undefined && <option value="">{anyLabel}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
};

const DAY_MS = 86_400_000;

const shift = (iso: string, days: number): string =>
  new Date(Date.parse(iso) - days * DAY_MS).toISOString().slice(0, 10);

export const HISTORY_PRESETS: Array<{ value: string; label: string; days: number | null }> = [
  { value: "30d", label: "30d", days: 30 },
  { value: "90d", label: "90d", days: 90 },
  { value: "1y", label: "1y", days: 365 },
  { value: "all", label: "All", days: null },
];

/**
 * Resolve a history preset into absolute bounds.
 *
 * Counted back from the LAST RECORDED DAY, not from today, and that difference
 * is the whole reason this exists. The archive ends in 2023: "the last 30 days"
 * measured from now is empty every time, which would make every preset but
 * "All" look like a broken chart.
 */
export const resolveHistoryWindow = (
  preset: string,
  extent: { from: string; to: string } | null,
): Record<string, string> => {
  if (!extent) return {};
  const found = HISTORY_PRESETS.find((p) => p.value === preset);
  if (!found || found.days === null) return {};
  return { from: shift(extent.to, found.days), to: extent.to };
};

/**
 * The window control for every history subpage.
 *
 * One parameter (`window`) rather than two dates, because the presets are what
 * anyone actually picks and a URL carrying `window=90d` survives a re-import
 * that shifts the dataset's end date. The absolute bounds are derived at
 * request time from the data's own extent.
 */
export const HistoryWindow = () => (
  <Segmented
    label="Window"
    param="window"
    fallback="all"
    options={HISTORY_PRESETS.map(({ value, label }) => ({ value, label }))}
  />
);

/** Read the current window preset and turn it into request parameters. */
export const useHistoryWindow = (
  extent: { from: string; to: string } | null,
): [string, Record<string, string>] => {
  const [preset] = useQueryParam("window", "all");
  return [preset, resolveHistoryWindow(preset, extent)];
};
