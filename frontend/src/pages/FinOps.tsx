import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Banner, Loading } from "../components.jsx";

/**
 * What this platform costs to run.
 *
 * The data is ACCOUNT-scoped and comes from one global stack, so every
 * environment sees every environment's spend (ADR-0015). That is deliberate:
 * hiding dev's cost from prod's page would only make the account total
 * unexplainable, and dev is usually where a surprise comes from.
 */
export const FinOpsPage = () => {
  const [groupBy, setGroupBy] = useState<"service" | "environment" | "stack">("service");
  const [environment, setEnvironment] = useState<string>("");
  const [data, setData] = useState<Awaited<ReturnType<typeof api.finops>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .finops({ groupBy, ...(environment ? { environment } : {}) })
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [groupBy, environment]);

  if (loading) return <Loading what="cost data" />;
  if (error) return <Banner variant="error">{error}</Banner>;

  if (data && !data.available) {
    // Says so, rather than rendering zeros that look like a free account.
    return (
      <>
        <h1>Cost</h1>
        <Banner>{data.reason}</Banner>
      </>
    );
  }

  const rows = data?.rows ?? [];
  const periods = [...new Set(rows.map((r) => r.period))].sort();
  const keys = [...new Set(rows.map((r) => r.key))];
  const total = rows.reduce((sum, r) => sum + r.cost, 0);

  const byKey = (key: string, period: string) =>
    rows.find((r) => r.key === key && r.period === period)?.cost ?? 0;

  const keyTotal = (key: string) =>
    rows.filter((r) => r.key === key).reduce((sum, r) => sum + r.cost, 0);

  return (
    <>
      <h1>Cost</h1>

      <section className="card">
        <div className="row">
          <div className="field">
            <label htmlFor="groupBy">Group by</label>
            <select
              id="groupBy"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}
            >
              <option value="service">AWS service</option>
              <option value="environment">Environment</option>
              <option value="stack">Stack</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="environment">Environment</label>
            <select
              id="environment"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
            >
              <option value="">All three</option>
              <option value="dev">dev</option>
              <option value="test">test</option>
              <option value="prod">prod</option>
            </select>
          </div>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {data?.from} to {data?.to} · total <strong className="mono">${total.toFixed(2)}</strong>
        </p>
      </section>

      <section className="card">
        <h2>Breakdown</h2>
        {rows.length === 0 ? (
          <p className="muted">
            No tagged spend in this window. Cost-allocation tags are not retroactive, so anything
            created before the tags were activated will never appear here.
          </p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{groupBy}</th>
                  {periods.map((p) => (
                    <th key={p} className="num">
                      {p}
                    </th>
                  ))}
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {keys
                  .sort((a, b) => keyTotal(b) - keyTotal(a))
                  .map((key) => (
                    <tr key={key}>
                      <td>{key}</td>
                      {periods.map((p) => (
                        <td key={p} className="num">
                          {byKey(key, p) ? `$${byKey(key, p).toFixed(2)}` : "—"}
                        </td>
                      ))}
                      <td className="num">
                        <strong>${keyTotal(key).toFixed(2)}</strong>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
};
