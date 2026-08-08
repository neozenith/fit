import { describe, expect, test } from "bun:test";
import { isCatalogueMissing, MISSING_CATALOGUE } from "./finops-errors.js";

/**
 * The narrow-catch boundary.
 *
 * `/api/finops` translates "the CUR catalogue is not populated yet" into a
 * clean `available: false`, because that is a normal state for hours after the
 * FinOps stack applies. Everything else must still throw.
 *
 * Getting that boundary wrong is silent in the worst direction: a pattern that
 * is too broad turns a permissions failure into "no data yet", and the page
 * looks healthy for a month while showing nothing.
 */

describe("messages that mean the catalogue is not populated yet", () => {
  test.each([
    ["Table 'cur' does not exist"],
    ["line 5:6: Table awsdatacatalog.fit_finops.cur does not exist"],
    ["Schema fit_finops does not exist"],
    ["TABLE_NOT_FOUND: line 1:15: Table not found"],
    ["SCHEMA_NOT_FOUND: Schema does not exist"],
    ["EntityNotFoundException: Entity Not Found"],
  ])("%p is treated as unavailable", (message) => {
    expect(MISSING_CATALOGUE.test(message)).toBe(true);
  });
});

describe("messages that are real defects and must still throw", () => {
  test.each([
    ["User is not authorized to perform: athena:StartQueryExecution"],
    ["AccessDeniedException: insufficient permissions on s3://fit-finops"],
    ["Query exhausted resources at this scale factor"],
    ["Bytes scanned limit was exceeded"],
    ["SYNTAX_ERROR: line 3:1: mismatched input 'GROUP'"],
    ["Athena query exceeded its 30s ceiling"],
    ["Insufficient permissions to execute the query"],
  ])("%p still throws", (message) => {
    expect(MISSING_CATALOGUE.test(message)).toBe(false);
  });
});

describe("isCatalogueMissing accepts an unknown, not just an Error", () => {
  test("an Error is classified by its message", () => {
    expect(isCatalogueMissing(new Error("Table 'cur' does not exist"))).toBe(true);
    expect(isCatalogueMissing(new Error("AccessDenied"))).toBe(false);
  });

  test("a thrown non-Error is stringified rather than crashing the classifier", () => {
    // A catch block receives `unknown`, and something in the SDK chain can
    // throw a string or an object. Crashing here would turn a recoverable
    // state into a 502 — the exact outcome this whole path exists to avoid.
    expect(isCatalogueMissing("Schema fit_finops does not exist")).toBe(true);
    expect(isCatalogueMissing({ toString: () => "does not exist" })).toBe(true);
    expect(isCatalogueMissing(undefined)).toBe(false);
    expect(isCatalogueMissing(null)).toBe(false);
  });
});
