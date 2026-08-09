# fit

A strength-training tracker that replaces a spreadsheet implementation of the
**Candito 6-Week Strength Program**. One user, three environments, one AWS
account, and no compute running when nobody is looking at it.

```
fit-dev.jpeak.ai      fit-test.jpeak.ai      fit.jpeak.ai
```

## The idea

A six-week block is a **projection of three numbers**. Your bench, squat and
deadlift one-rep maxes — plus a units flag and a start date — determine every
prescribed weight across roughly 22 sessions. Not one working weight is entered
by hand.

So the application does not store a training plan. It stores the three numbers
and what you actually lifted, and recomputes the plan on every read. Correct a
max and the whole block moves, instantly, in the browser.

At the end of week 5 a single set of 1-4 reps at 97.5% becomes the seed for the
next block, and the cycle restarts one step heavier. That recursion *is* the
program.

Read [`docs/domain-model.md`](docs/domain-model.md) for the full mechanics,
including the two arithmetic bugs found in the source workbook and what was done
about them.

## Getting started

```sh
make install           # dependencies
make dev               # DynamoDB Local + API + SPA, all real handlers
make token ENV=local   # mint a session so you can sign in
```

Then open <http://localhost:5173>.

Local development runs the **same** handler modules the Lambda wraps, against
DynamoDB Local, with the same signature verification production uses. The only
things that differ are transport and backing store — there is deliberately no
`if (isLocal) skipAuth` branch anywhere in the request path.

## The inner loop

```sh
make fix ci      # format, lint, typecheck, unit tests, terraform validate
make e2e         # Playwright against the local stack
make tf-check    # terraform fmt-check + validate. No cloud, no state.

make history                    # curate reference/*.xlsx into local Parquet
make publish-history ENV=dev    # upload that archive to an environment
make duckdb-layer               # build the linux-arm64 DuckDB Lambda layer
```

`make ci` is free, offline and deterministic. Anything that spends money or
touches AWS is a **sibling** target, never a dependency of it.

## Architecture in one diagram

```mermaid
flowchart LR
    viewer["👤 Viewer"]:::infra
    idp["🪪 EntraID"]:::gate
    auth["🔐 auth Lambda@Edge<br/>viewer-request"]:::gate
    cf["🌐 CloudFront"]:::compute
    s3["📦 S3 — SPA assets"]:::data
    api["⚡ API Lambda<br/>Function URL, AWS_IAM"]:::compute
    ddb[("🗄️ DynamoDB<br/>13-month hot window")]:::data
    parquet[("🧊 S3 Parquet<br/>read by DuckDB")]:::data
    aged["📤 age-out<br/>monthly"]:::compute

    viewer --> auth
    auth -- "no session" --> idp
    auth -- "x-auth-email / exp / sig" --> cf
    cf -- "/*" --> s3
    cf -- "/api/*" --> api
    api --> ddb
    api -- "older than 13 months" --> parquet
    ddb --> aged --> parquet

    classDef compute fill:#5c4295,stroke:#c3b0fd,color:#fff,stroke-width:2px
    classDef data fill:#047857,stroke:#6ee7b7,color:#fff,stroke-width:2px
    classDef infra fill:#475569,stroke:#cbd5e1,color:#fff,stroke-width:2px
    classDef gate fill:#b91c1c,stroke:#fca5a5,color:#fff,stroke-width:2px
```

No VPC, no NAT gateway, no load balancer, no containers, no relational database.
Idle cost is the hosted zone, the CloudFront distribution, and stored bytes.

Full detail — including every failure mode — is in
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## How it deploys

Promotion is a **Git event**, never a workflow input.

| You do this | This happens |
|---|---|
| Open a **draft** pull request | `plan` across dev, test and prod. Nothing applies. |
| Mark it **ready for review** | `apply / dev` |
| Merge to **`main`** | `apply / test` |
| Push a **`v*` tag** | `apply / prod` |

A draft pull request is therefore a genuine, zero-risk "what would this do
everywhere" report. Marking it ready is the act that first mutates cloud state,
and it mutates dev only.

Six stacks deploy independently, so a CloudFront change (fifteen minutes to
propagate) never blocks an API deploy (seconds):

| Stack | Owns | Changes when |
|---|---|---|
| `identity` | IdP credentials, the session signing key | rarely |
| `data` | DynamoDB tables, archive bucket | rarely |
| `api` | the request handler | often |
| `edge` | certificate, CloudFront, the authenticator | rarely, slowly |
| `archive` | the Parquet age-out job | rarely |
| `finops` | cost reporting — **global**, merge to `main` only | rarely |

## Sign-in

Sign in with a Microsoft account in the `jpeakai.onmicrosoft.com` tenant, on any
of the three hostnames. The app registration is `fit`
(`9f4078bd-0dac-4bb1-9e56-303979d33eb1`), single-tenant, with a redirect URI
registered for every environment and for `localhost:5173`.

Admission needs BOTH checks to pass: the token's `tid` must match the tenant,
AND the address must appear in that environment's `allowed_users` parameter. The
tenant check alone would admit every account in the directory.

OAuth terminates at a **Lambda@Edge viewer-request function**, never in the
application. It strips every inbound `x-auth-*` header before doing anything
else, rejects a non-canonical `Host` with 421, handles `/oauth2/*` entirely at
the edge, and injects a short-lived signed identity that the origin verifies.

The application has no login code, no session store, and no identity-provider
dependency. Its entire auth surface is "verify one HMAC".

### Testing a deployed environment

```sh
make token ENV=dev                       # mint a 10-minute session
bun run tools/smoke.ts --env dev         # check every API route
bun run --cwd e2e test -- --project=dev  # the full browser suite
```

The session is derived from the environment's SSM signing key at use time, using
your own AWS credentials — nothing is stored, and access to a test session is
exactly access to that parameter. Minted sessions are marked `actor=agent`, so
they are distinguishable from a human sign-in everywhere they appear.

## Standing it up from nothing

Four commands, each idempotent, each run by a human:

```sh
make bootstrap             # OIDC provider, state bucket, deployer role
make bootstrap-tags        # activate cost-allocation tags — BEFORE any spend
make github-environments   # dev/test/prod and their promotion gates
make entra                 # the OAuth app registration
```

Everything above that layer is Terraform, and Terraform runs in CI alone. The
bootstrap is the exception because it creates the role and bucket that CI needs,
so it cannot run in the pipeline it bootstraps.

> **Cost-allocation tags are not retroactive.** Spend incurred before the tags
> are activated is permanently unattributable, which is why that step runs
> before the first apply rather than after.

## Where things are

| Path | What |
|---|---|
| `packages/program/` | The program engine. Pure, dependency-free, 83 tests. |
| `api/` | The request handler, plus its Lambda and local adapters. |
| `frontend/` | The SPA. |
| `infra/bootstrap/` | The one layer a human runs. |
| `infra/modules/` | Resources live here. |
| `infra/stacks/` | Wiring and naming live here. No `resource` blocks. |
| `tools/` | Seeding, the dev runner, session minting, smoke tests. |
| `e2e/` | Playwright, one project per environment. |
| `docs/questions/` | Open questions, each with the assumption taken. |

## Documents

| Document | What it is for |
|---|---|
| [`ADRs.md`](ADRs.md) | Every structural decision, each with a forward **Lens**. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The deployed shape and the failure inventory. |
| [`GLOSSARY.md`](GLOSSARY.md) | The vocabulary. Read it before naming anything. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | The loop, the invariants, and how promotion works. |
| [`CLAUDE.md`](CLAUDE.md) | Operating notes and gotchas for an agent. |
| [`docs/domain-model.md`](docs/domain-model.md) | What the training program actually is. |

## Reading order for the reasoning

1. [`ADRs.md`](ADRs.md) — every structural decision, each carrying a **Lens**:
   the forward rule it projects. Most design questions are already answered
   there.
2. [`docs/domain-model.md`](docs/domain-model.md) — what the program actually is.
3. [`ARCHITECTURE.md`](ARCHITECTURE.md) — how it is built, and how it fails.
4. [`CLAUDE.md`](CLAUDE.md) — the invariants and the gotchas.

## Licence

MIT. See [`LICENSE`](LICENSE).
