# CLAUDE.md: `.github/actions/terraform`

Read the ADR log below before changing this action. Each entry carries a
**Lens** — the forward rule it projects — so the next related question is
answered without re-litigating the last one.

## The development contract

Run from the repository root, never `cd`:

```sh
make tf-check                              # the static half, locally
bunx --bun @biomejs/biome check .github    # formatting of the YAML's JSON siblings
gh workflow run cold-start.yml -f environment=dev   # exercise apply end to end
```

There is no way to run this action locally — it is a composite action and its
value is entirely in what it does with cloud credentials. The real test is a
draft pull request, which plans all three environments and applies none.

Green before handoff: `make ci`, plus a draft-PR plan that shows only the
intended diff.

## File map

| File | Role |
|---|---|
| `action.yml` | The contract. Inputs, and the six steps. |
| `README.md` | Human explainer: quickstart, diagrams, troubleshooting. |
| `CLAUDE.md` | This file. Why it is shaped this way. |

## Architecture principles

1. **Apply consumes the saved plan.** Never re-plan at apply time.
2. **Plan always runs, for both actions.** An apply without a preceding plan in
   the same job has nothing to apply and nothing to show.
3. **No stack-specific logic** beyond the single `build_app` flag. If a second
   stack needs special handling, that is a signal the special handling belongs
   in the stack.
4. **Credentials arrive as inputs**, never read from the environment inside the
   action, so the caller decides which role is in play.

## ADR log

### ADR-A1 — Apply consumes the artefact plan, never a fresh one

**Status:** Accepted.
**Context.** The obvious shape is `terraform apply -auto-approve`, which plans
and applies in one step. That means the thing applied was computed *after* the
reviewer looked at the plan — and between those two moments, an upstream SSM
parameter, a data source, or another stack's apply can have changed the answer.
**Decision.** `plan -out=tfplan` then `apply tfplan`.
**Consequences.** A stale plan fails loudly ("saved plan is stale") instead of
applying something unreviewed. Plan and apply must run in the same job, because
the artefact does not cross job boundaries.

> **Lens.** A review gate is only real if the reviewed artefact is the applied
> artefact. Any change that recomputes work between review and execution
> destroys the gate, however convenient it looks.

### ADR-A2 — `-detailed-exitcode` is handled, not propagated

**Status:** Accepted.
**Context.** `-detailed-exitcode` distinguishes "no changes" (0) from "changes
present" (2) from "error" (1). Under `set -e`, a plan with changes — the normal
case — would fail the job.
**Decision.** Capture the code; fail only on 1.
**Consequences.** The exit code stays available for a future "fail the PR if
prod would change" gate, which a bare `plan` could not support.

> **Lens.** When a tool encodes information in its exit code, handle the codes
> individually. Collapsing them to zero/non-zero throws away the reason.

### ADR-A3 — The API bundle is built inside this action, behind a flag

**Status:** Accepted.
**Context.** The `api` stack's `archive_file` zips `api/dist`, which does not
exist on a fresh checkout. A plan without it fails on a missing path — an error
that reads as an infrastructure problem and is not one. Building unconditionally
would add a minute of `bun install` to all five other stacks' plans.
**Decision.** A `build_app` input, set only by the `api` caller. It asserts the
bundle is non-empty afterwards.
**Consequences.** The assertion matters more than the build: an empty directory
hashes differently every run, so every plan would show a spurious change.

> **Lens.** When a plan depends on a build artefact, verify the artefact is real
> before planning. A missing input surfaces as infrastructure drift, which is
> the most misleading place for it to appear.

### ADR-A4 — The role session is named after stack, environment and run

**Status:** Accepted.
**Context.** Every apply in this account is made by one role. CloudTrail
therefore shows a wall of identical principals, and attributing a change means
correlating timestamps by hand.
**Decision.** `role-session-name: gha-{stack}-{env}-{run_id}`.
**Consequences.** A CloudTrail entry names the workflow run that caused it. The
session name is capped at 64 characters, so a much longer stack name would need
truncating.

> **Lens.** Make the audit trail self-describing at the point of authentication.
> Attribution added later is reconstruction; attribution added here is fact.

## Extension checklist

- [ ] `action.yml` — new input has a `description` and a `default` unless truly required
- [ ] `README.md` — inputs table and troubleshooting row updated
- [ ] `CLAUDE.md` — an ADR entry if the change is a decision rather than a tweak
- [ ] Verified on a **draft** PR (plans all three environments, applies none)
- [ ] No stack-specific branching beyond `build_app`
- [ ] Diagrams still under ~15 nodes

## Known gotchas

- **`plan` binds no GitHub Environment, and must not.** prod is gated to `v*`
  tags, so a `plan / prod` job on a PR branch would be rejected by that gate.
  Plans take the role from the repo-level variable; only applies bind
  `environment:`.
- **`-reconfigure` on `init` is load-bearing.** Without it, a runner reusing a
  cached `.terraform` directory from another environment silently keeps the old
  backend — and applies to the wrong environment.
- **The plan summary is truncated to 60000 characters.** A job summary caps at
  1MB, and a large plan will exceed it and silently drop the whole step.
- **`aws_region` is the region of the *provider*, not of the state bucket.** The
  bucket's region comes from `backends/{env}.config`.
