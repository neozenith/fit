/**
 * `plotly.js-basic-dist-min` ships no type declarations.
 *
 * Declared as `unknown` rather than `any` so nothing downstream silently loses
 * type checking: `plot.tsx` narrows it once, through an explicit interface
 * naming the three functions this app calls, and that interface is the only
 * place a Plotly API is described. `any` here would propagate through every
 * chart and make a typo in a trace property a runtime discovery.
 */
declare module "plotly.js-basic-dist-min" {
  const plotly: unknown;
  export default plotly;
}
