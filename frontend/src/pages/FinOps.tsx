import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Banner, Loading } from "../components.jsx";
import { Segmented } from "../filters.jsx";
import { Plot, seriesColour } from "../plot.jsx";
import { useQueryParam } from "../router.jsx";

/**
 * What this platform costs to run.
 *
 * The data is ACCOUNT-scoped and comes from one global stack, so every
 * environment sees every environment's spend (ADR-0015). That is deliberate:
 * hiding dev's cost from prod's page would only make the account total
 * unexplainable, and dev is usually where a surprise comes from.
 *
 * Every filter is in the URL. `?range=7d&groupBy=environment&environment=dev`
 * opens exactly that view, which is the difference between describing a cost
 * spike and pointing at it.
 */

const RANGES = [
  { value: "1d", label: "1d" },
  { value: "3d", label: "3d" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
];

const GRAINS = [
  { value: "", label: "Auto" },
  { value: "hour", label: "Hour" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

const GROUPINGS = [
  { value: "service", label: "Service" },
  { value: "environment", label: "Environment" },
  { value: "stack", label: "TF stack" },
];

const ENVIRONMENTS = [
  { value: "", label: "All" },
  { value: "dev", label: "dev" },
  { value: "test", label: "test" },
  { value: "prod", label: "prod" },
];

/** "1 day", "2 days" — a heading reading "over 1 days" looks like a bug. */
const unit = (n: number, word: string): string => (n === 1 ? word : `${word}s`);

/**
 * How stale the numbers are.
 *
 * Prominent because every figure on this page is silently a few hours old: AWS
 * refreshes a CUR on its own cadence, so "today cost nothing" is almost always
 * "today has not been delivered yet". Stating the newest timestamp and its age
 * turns a wrong answer into a qualified one.
 *
 * The timestamp is UTC — a CUR records no offset — and it is labelled as such
 * rather than being converted, because a reader comparing it against an AWS
 * console that also shows UTC should not have to undo a conversion.
 */
const Recency = ({
  recency,
}: {
  recency: { latest: string | null; ageSeconds: number | null; rows: number } | null;
}) => {
  if (!recency?.latest) return null;
  const age = recency.ageSeconds ?? 0;
  const hours = Math.floor(age / 3600);
  const label =
    age < 3600
      ? `${Math.max(0, Math.floor(age / 60))} minutes`
      : hours < 48
        ? `${hours} hours`
        : `${Math.floor(hours / 24)} days`;

  // Beyond a day the export has almost certainly stopped, rather than merely
  // lagging — worth flagging rather than reporting neutrally.
  const stale = age > 36 * 3600;

  return (
    <section className="card">
      <div className="grid">
        <div>
          <div className="muted">Most recent record</div>
          <div className="stat-value mono">{recency.latest.replace("T", " ")}</div>
          <div className="muted">UTC — a CUR records no offset</div>
        </div>
        <div>
          <div className="muted">Delivery lag</div>
          <div className={`stat-value${stale ? " status-warning" : ""}`}>{label} behind</div>
          <div className="muted">
            {stale ? "Longer than a refresh cycle; check the export." : "Within the usual cadence."}
          </div>
        </div>
        <div>
          <div className="muted">Rows in the export</div>
          <div className="stat-value mono">{recency.rows.toLocaleString()}</div>
          <div className="muted">Hourly granularity</div>
        </div>
      </div>
    </section>
  );
};

const USD = (v: number): string =>
  v >= 1 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(4)}` : "$0";

export const FinOpsPage = () => {
  const [range] = useQueryParam("range", "30d");
  const [grain] = useQueryParam("grain", "");
  const [groupBy] = useQueryParam("groupBy", "service");
  const [environment] = useQueryParam("environment", "");
  const [chart] = useQueryParam("chart", "stacked");
  const [recency, setRecency] = useState<Awaited<ReturnType<typeof api.finopsRecency>> | null>(
    null,
  );

  const [data, setData] = useState<Awaited<ReturnType<typeof api.finops>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .finops({
        range,
        groupBy,
        ...(grain ? { grain } : {}),
        ...(environment ? { environment } : {}),
      })
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [range, grain, groupBy, environment]);

  // Fetched once, not per filter change: recency does not vary with any of
  // them, and re-running the whole-export scan on every range click would make
  // the page's slowest query its most frequent one.
  useEffect(() => {
    api
      .finopsRecency()
      .then(setRecency)
      .catch(() => setRecency(null));
  }, []);

  const filters = (
    <div className="filters">
      <Segmented label="Range" param="range" fallback="30d" options={RANGES} />
      <Segmented label="Bucket" param="grain" fallback="" options={GRAINS} />
      <Segmented label="Group by" param="groupBy" fallback="service" options={GROUPINGS} />
      <Segmented label="Environment" param="environment" fallback="" options={ENVIRONMENTS} />
      <Segmented
        label="Chart"
        param="chart"
        fallback="stacked"
        options={[
          { value: "stacked", label: "Stacked" },
          { value: "lines", label: "Lines" },
          { value: "total", label: "Total" },
        ]}
      />
    </div>
  );

  if (error) {
    return (
      <>
        <h1>Cost</h1>
        {filters}
        <Banner variant="error">{error}</Banner>
      </>
    );
  }
  if (loading && !data) return <Loading what="cost data" />;

  if (data && !data.available) {
    // Says so, rather than rendering zeros that look like a free account.
    return (
      <>
        <h1>Cost</h1>
        {filters}
        <Banner>{data.reason}</Banner>
      </>
    );
  }

  const rows = data?.rows ?? [];
  const periods = [...new Set(rows.map((r) => r.period))].sort();
  const keys = [...new Set(rows.map((r) => r.key))];
  const total = rows.reduce((sum, r) => sum + r.cost, 0);

  const keyTotal = (key: string) =>
    rows.filter((r) => r.key === key).reduce((sum, r) => sum + r.cost, 0);

  // Largest contributor first, so the legend and the table agree on what matters
  // and the stack orders consistently between renders.
  const ranked = [...keys].sort((a, b) => keyTotal(b) - keyTotal(a));

  const cell = (key: string, period: string) =>
    rows.find((r) => r.key === key && r.period === period)?.cost ?? 0;

  const traces =
    chart === "total"
      ? [
          {
            type: "bar",
            name: "Total",
            x: periods,
            y: periods.map((p) =>
              rows.filter((r) => r.period === p).reduce((s, r) => s + r.cost, 0),
            ),
            marker: { color: seriesColour(0) },
            hovertemplate: "%{x}<br>$%{y:.4f}<extra></extra>",
          },
        ]
      : ranked.map((key, i) => ({
          type: chart === "lines" ? "scatter" : "bar",
          mode: chart === "lines" ? "lines+markers" : undefined,
          name: key,
          x: periods,
          y: periods.map((p) => cell(key, p)),
          marker: { color: seriesColour(i) },
          line: chart === "lines" ? { color: seriesColour(i), width: 2 } : undefined,
          hovertemplate: `%{x}<br>${key}: $%{y:.4f}<extra></extra>`,
        }));

  return (
    <>
      <h1>Cost</h1>
      <p className="muted">
        Account-wide, from one global export. Every environment sees every environment's spend —
        hiding dev's from prod's page would only make the account total unexplainable.
      </p>

      <Recency recency={recency} />

      {filters}

      <section className="card">
        <h2>
          {USD(total)}
          <span className="muted">
            {" "}
            over {periods.length} {unit(periods.length, data?.grain ?? "period")}
            {environment ? ` in ${environment}` : ""}
          </span>
        </h2>
        {periods.length === 0 ? (
          <Banner>
            No cost was recorded in this window. AWS delivers a CUR up to 24 hours late, so a very
            recent range can be legitimately empty.
          </Banner>
        ) : (
          <Plot
            title={`Cost by ${groupBy}, per ${data?.grain ?? "period"}`}
            height={380}
            data={traces}
            layout={{
              barmode: "stack",
              yaxis: { title: { text: "USD" }, tickformat: "$,.4f" },
              // Without this a single period stretches its bar across the whole
              // plot, because Plotly sizes bars from the spacing between points
              // and one point has none. A one-day range is the common case for
              // a freshly created export.
              ...(periods.length === 1 ? { bargap: 0.8 } : {}),
            }}
          />
        )}
      </section>

      <section className="card">
        <h2>Breakdown</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{GROUPINGS.find((g) => g.value === groupBy)?.label ?? groupBy}</th>
                {periods.map((p) => (
                  <th key={p}>{p}</th>
                ))}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((key) => (
                <tr key={key}>
                  <td>{key}</td>
                  {periods.map((p) => (
                    <td key={p} className="mono">
                      {USD(cell(key, p))}
                    </td>
                  ))}
                  <td className="mono">{USD(keyTotal(key))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Total</th>
                {periods.map((p) => (
                  <th key={p} className="mono">
                    {USD(rows.filter((r) => r.period === p).reduce((s, r) => s + r.cost, 0))}
                  </th>
                ))}
                <th className="mono">{USD(total)}</th>
              </tr>
            </tfoot>
          </table>
        </div>
        {groupBy === "stack" && (
          <p className="muted">
            Grouping by stack reports <code className="mono">(untagged)</code> in this account.
            Every resource carries the <code className="mono">Stack</code> tag, but this is a linked
            account and activating a cost-allocation tag is the payer's to do.
          </p>
        )}
      </section>
    </>
  );
};
