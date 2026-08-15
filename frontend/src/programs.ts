import {
  BUILTIN_PROGRAMS,
  compileCustomProgram,
  findBuiltinProgram,
  type Program,
} from "@fit/program";
import { useEffect, useState } from "react";
import { api } from "./api.js";

/**
 * Resolving a Program in the browser.
 *
 * The SPA rolls blocks out locally using the same module the server uses
 * (ADR-0019), which is what makes the block preview move as you type and the
 * year view render without a request per block. That only works if the browser
 * can resolve a `programId` to a `Program` — built-in or custom.
 *
 * Built-ins need no fetch at all: they are compiled into the bundle. Custom ones
 * need their definition and their plans, which is one request each, made once
 * per page rather than once per block.
 */

export interface ProgramResolver {
  /** Every program available, built-ins first. */
  programs: Program[];
  /** `undefined` when the id is unknown — a custom program that was retired. */
  find: (programId: string) => Program | undefined;
  loading: boolean;
}

export const usePrograms = (): ProgramResolver => {
  const [custom, setCustom] = useState<Program[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    Promise.all([api.programs(), api.plans()])
      .then(([programsResponse, plansResponse]) => {
        if (!live) return;
        const compiled: Program[] = [];
        for (const definition of programsResponse.definitions) {
          if (definition.retired) continue;
          try {
            compiled.push(compileCustomProgram(definition, plansResponse.plans));
          } catch {
            // The API reports this in `broken`. Skipping it here keeps one bad
            // definition from making every other program unresolvable.
          }
        }
        setCustom(compiled);
      })
      // A failure here leaves the built-ins working, which is the overwhelming
      // majority of blocks. The page's own error surface is for failures that
      // block work.
      .catch(() => setCustom([]))
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const programs = [...BUILTIN_PROGRAMS, ...custom];

  return {
    programs,
    // Built-ins are checked first and without scanning the custom list, so the
    // common case costs nothing.
    find: (programId) =>
      findBuiltinProgram(programId) ?? custom.find((p) => p.programId === programId),
    loading,
  };
};
