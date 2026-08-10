#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["polars==1.34.0"]
# ///
"""Trickle-extract the full Strava activity history into a local cache.

Strava allows 100 read requests per 15 minutes and 1,000 per day, and a decade
of activities is more requests than one sitting. So this is not a "run it once
and hope" importer: it is a RESUMABLE one. Every run does as much as the
remaining budget allows, records exactly where it stopped, and exits clean. Run
it again in fifteen minutes and it picks up from there.

    make strava-status         # what is cached, what is left, what budget remains
    make strava-pull           # one trickle batch, bounded by the read budget
    make strava-export         # cache -> Parquet

Two phases, both resumable:

  1. INDEX  — page through `GET /athlete/activities`, 200 summaries per request.
              Cheap: the whole history is a handful of requests.
  2. DETAIL — `GET /activities/{id}` once per activity, for the fields the
              summary omits (calories, gear, device, perceived exertion).
              Expensive: one request each, and this is what trickles.

The cache is the deliverable. `reference/strava/cache.sqlite` holds one row per
activity with its response stored VERBATIM, so re-deriving a different Parquet
shape later never costs another API call. Parquet is a VIEW of that cache, not
the record of it.

Nothing is discarded on the way in. The route polyline, laps, splits and segment
efforts ride along in the same response as the overall statistics, so keeping
them is free while dropping them would mean re-spending a rate-limited allowance
to ever get them back. The brief — overall statistics and activity type — is
served by the EXPORT schema, which narrows a payload that is already on disk.

What is never requested at all: activity STREAMS (`/activities/{id}/streams`,
the per-point time series) are a separate endpoint and a separate request each,
and those are genuinely not wanted.

Output lives under `reference/`, which is gitignored: this is personal training
data and it stays on the machine that pulled it.

Not degradable. A missing credential, an expired grant or an unparseable rate
limit header raises — because a "sync" that silently fetched nothing is
indistinguishable from a sync that had nothing to fetch.
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import polars as pl

log = logging.getLogger("strava")

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CREDS = ROOT / "reference" / "strava.creds.txt"
STRAVA_DIR = ROOT / "reference" / "strava"

API = "https://www.strava.com/api/v3"
TOKEN_URL = "https://www.strava.com/oauth/token"
AUTHORIZE_URL = "https://www.strava.com/oauth/authorize"

# `activity:read_all` rather than `activity:read`, because the narrower scope
# omits activities marked private or hidden — and an archive with silent holes in
# it is worse than no archive, since nothing reports the gap.
SCOPES = "read,activity:read_all,profile:read_all"

# The loopback the browser is redirected back to. Strava matches the redirect
# against the app's registered "Authorization Callback Domain", which must be set
# to `localhost` for this to complete.
CALLBACK_HOST = "localhost"
CALLBACK_PORT = 8721
USER_AGENT = "fit-strava-extract/1.0 (+https://github.com/joshpeak/fit)"

PER_PAGE = 200

# Reserve part of the 15-minute read budget rather than spending it to the last
# request. Two reasons: the counters Strava reports are its own, not ours, and a
# 429 is not free — a request that violates the short-term limit still counts
# against the daily one. Stopping early costs a few minutes; overrunning costs
# quota that does not come back until midnight UTC.
DEFAULT_RESERVE_15MIN = 5
DEFAULT_RESERVE_DAILY = 50

# Refresh this far ahead of the stated expiry. Strava's clock is not ours, and a
# token that expires mid-batch turns a clean stop into a 401 halfway through.
TOKEN_SKEW = timedelta(minutes=5)

# Nothing is stripped on ingest. The route polyline, laps, splits and segment
# efforts all arrive inside the SAME response as the overall statistics — they
# cost no extra request, and discarding them would mean re-spending a
# rate-limited allowance to get them back. The narrowing to overall statistics
# happens at EXPORT, where it is free and reversible.


class StravaError(RuntimeError):
    """Anything that means the extract cannot honestly continue."""


# ---------------------------------------------------------------------------
# Credentials — an INI-shaped file this tool both reads and REWRITES, because
# Strava rotates the refresh token on every refresh; keeping the old one is the
# same as having no credentials at all.
#
# One `[section]` per Strava app, because a Strava app belongs to exactly one
# account and rate limits are counted per app. A flat file cannot hold two: the
# same key appears twice, the second silently wins, and a write-back flattens
# both into one — which is how a working grant gets destroyed by a refresh.
# Editing is line-based rather than via configparser so comments survive.
# ---------------------------------------------------------------------------

REQUIRED_KEYS = frozenset({"client_id", "client_secret"})


def parse_creds(path: Path) -> tuple[str | None, dict[str, dict[str, str]]]:
    """Return (default account name, {account: {key: value}})."""
    if not path.exists():
        raise StravaError(f"No credentials at {path}")
    preamble: dict[str, str] = {}
    accounts: dict[str, dict[str, str]] = {}
    current: dict[str, str] | None = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            current = accounts.setdefault(line[1:-1].strip(), {})
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        (preamble if current is None else current)[key.strip()] = value.strip()
    if not accounts:
        raise StravaError(
            f"{path} has no [account] sections. Wrap each Strava app's keys under a "
            "header naming the account it belongs to, e.g. `[joshpeak05]`."
        )
    return preamble.get("default_account"), accounts


def resolve_account(path: Path, requested: str | None) -> str:
    default, accounts = parse_creds(path)
    name = requested or default or (next(iter(accounts)) if len(accounts) == 1 else None)
    if name is None:
        raise StravaError(
            f"{path} holds several accounts ({', '.join(accounts)}) and names no "
            "`default_account=`. Pass --account."
        )
    if name not in accounts:
        raise StravaError(f"No [{name}] in {path}. Known accounts: {', '.join(accounts)}")
    return name


def read_creds(
    path: Path, account: str, *, require: frozenset[str] = frozenset()
) -> dict[str, str]:
    creds = parse_creds(path)[1][account]
    # client_id and client_secret identify the app and are always required.
    # refresh_token is only required once there IS a grant — `auth login` is the
    # command whose whole job is to create one, so it asks for less.
    missing = (REQUIRED_KEYS | set(require)) - creds.keys()
    if missing:
        raise StravaError(
            f"[{account}] in {path} is missing: {', '.join(sorted(missing))}. "
            "Add them as `key=value` under that header; client_id and client_secret "
            "are at https://www.strava.com/settings/api"
        )
    return creds


def write_creds(path: Path, account: str, creds: dict[str, str]) -> None:
    """Update one section in place, leaving every other line byte-identical.

    Rewriting the whole file from parsed state would drop comments and, worse,
    re-serialise the OTHER accounts from a partial read. Only the lines inside
    the target section are touched.
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    start = next(
        (i for i, ln in enumerate(lines) if ln.strip() == f"[{account}]"),
        None,
    )
    if start is None:
        raise StravaError(f"No [{account}] section to update in {path}")
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].strip().startswith("[")),
        len(lines),
    )
    remaining = dict(creds)
    for i in range(start + 1, end):
        key = lines[i].split("=", 1)[0].strip()
        if key in remaining and not lines[i].strip().startswith("#"):
            lines[i] = f"{key}={remaining.pop(key)}"
    # Keys the section never had (`scope` on first login) go at its end, before
    # whatever trailing blank lines separate it from the next section.
    tail = end
    while tail > start + 1 and not lines[tail - 1].strip():
        tail -= 1
    lines[tail:tail] = [f"{k}={v}" for k, v in remaining.items()]

    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tmp.replace(path)  # atomic: a half-written credential file is unrecoverable


def _expiry(creds: dict[str, str]) -> datetime | None:
    raw = creds.get("expires_at")
    if not raw:
        return None
    if raw.isdigit():  # Strava's own form is epoch seconds
        return datetime.fromtimestamp(int(raw), UTC)
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def _request(url: str, *, data: bytes | None = None, token: str | None = None) -> tuple[Any, dict[str, str]]:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            return payload, {k.lower(): v for k, v in resp.headers.items()}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        if exc.code == 429:
            raise StravaError(f"429 rate limited by Strava: {detail}") from exc
        if exc.code == 401:
            raise StravaError(
                f"401 unauthorized: {detail}\n"
                "       Run `uv run tools/strava.py auth login` to mint a grant with the "
                f"scopes this tool needs ({SCOPES})."
            ) from exc
        raise StravaError(f"HTTP {exc.code} from {url}: {detail}") from exc


class Budget:
    """The remaining read allowance, as reported by Strava itself.

    Strava returns its own counters on every response, so after one request the
    real remaining budget is known — no local guessing. Before that first
    response the pessimistic assumption is used (`unknown`), which is what makes
    a fresh process safe to start at any point in the 15-minute window.
    """

    def __init__(self, reserve_15: int, reserve_day: int) -> None:
        self.reserve_15 = reserve_15
        self.reserve_day = reserve_day
        self.limit_15: int | None = None
        self.limit_day: int | None = None
        self.usage_15: int | None = None
        self.usage_day: int | None = None

    def observe(self, headers: dict[str, str]) -> None:
        limit = headers.get("x-readratelimit-limit") or headers.get("x-ratelimit-limit")
        usage = headers.get("x-readratelimit-usage") or headers.get("x-ratelimit-usage")
        if not limit or not usage:
            # Not a soft failure to swallow: without these the tool has no idea
            # how close it is to a 429, and quietly guessing is how a daily
            # allowance gets burned.
            raise StravaError(
                "Strava returned no rate-limit headers; refusing to keep requesting blind"
            )
        self.limit_15, self.limit_day = (int(x) for x in limit.split(",")[:2])
        self.usage_15, self.usage_day = (int(x) for x in usage.split(",")[:2])

    @property
    def known(self) -> bool:
        return self.usage_15 is not None

    def remaining(self) -> tuple[int, int]:
        if not self.known:
            return (1, 1)  # enough for the probe request that reveals the truth
        assert self.limit_15 and self.limit_day and self.usage_15 is not None and self.usage_day is not None
        return (
            max(0, self.limit_15 - self.usage_15 - self.reserve_15),
            max(0, self.limit_day - self.usage_day - self.reserve_day),
        )

    def exhausted(self) -> str | None:
        """The reason to stop, or None to keep going."""
        short, day = self.remaining()
        if day <= 0:
            return "daily read limit reached (resets at midnight UTC)"
        if short <= 0:
            return "15-minute read limit reached (resets within 15 minutes)"
        return None

    def describe(self) -> str:
        if not self.known:
            return "read budget: unknown until the first response"
        short, day = self.remaining()
        return (
            f"read budget: {self.usage_15}/{self.limit_15} used this 15min "
            f"({short} spendable), {self.usage_day}/{self.limit_day} used today "
            f"({day} spendable)"
        )


class Client:
    def __init__(self, creds_path: Path, account: str, budget: Budget) -> None:
        self.creds_path = creds_path
        self.account = account
        self.creds = read_creds(creds_path, account, require=frozenset({"refresh_token"}))
        self.budget = budget

    def token(self) -> str:
        expiry = _expiry(self.creds)
        access = self.creds.get("access_token")
        if access and expiry and expiry - TOKEN_SKEW > datetime.now(UTC):
            return access
        return self.refresh()

    def refresh(self) -> str:
        log.info("refreshing access token")
        body = urllib.parse.urlencode(
            {
                "client_id": self.creds["client_id"],
                "client_secret": self.creds["client_secret"],
                "grant_type": "refresh_token",
                "refresh_token": self.creds["refresh_token"],
            }
        ).encode()
        payload, _ = _request(TOKEN_URL, data=body)
        # The refresh token ROTATES. Persisting the new one before returning is
        # what makes this tool re-runnable; losing it means re-authorizing in a
        # browser.
        self.creds["access_token"] = payload["access_token"]
        self.creds["refresh_token"] = payload["refresh_token"]
        self.creds["expires_at"] = (
            datetime.fromtimestamp(int(payload["expires_at"]), UTC)
            .isoformat()
            .replace("+00:00", "Z")
        )
        write_creds(self.creds_path, self.account, self.creds)
        log.info("token refreshed, valid until %s", self.creds["expires_at"])
        return self.creds["access_token"]

    def get(self, path: str, **params: Any) -> Any:
        stop = self.budget.exhausted()
        if stop:
            raise BudgetExhausted(stop)
        url = f"{API}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        payload, headers = _request(url, token=self.token())
        self.budget.observe(headers)
        return payload


class BudgetExhausted(Exception):
    """Not an error — the batch ran out of allowance and stopped cleanly."""


# ---------------------------------------------------------------------------
# Initial authorization
#
# A refresh token only ever carries the scopes it was minted with, so a grant
# without `activity:read_all` cannot be widened by refreshing it — it has to be
# replaced. That is this flow, and it is why the tool owns it rather than
# assuming a token appeared from somewhere.
# ---------------------------------------------------------------------------


def authorize(creds_path: Path, account: str, *, port: int) -> dict[str, str]:
    """Run the OAuth code exchange against a one-shot loopback listener."""
    creds = read_creds(creds_path, account)
    redirect_uri = f"http://{CALLBACK_HOST}:{port}/callback"
    url = f"{AUTHORIZE_URL}?" + urllib.parse.urlencode(
        {
            "client_id": creds["client_id"],
            "redirect_uri": redirect_uri,
            "response_type": "code",
            # `force` because Strava silently reuses an existing narrower grant
            # otherwise — which is exactly the state this flow exists to escape.
            "approval_prompt": "force",
            "scope": SCOPES,
        }
    )
    captured: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802 — stdlib's naming, not ours
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            captured.update({k: v[0] for k, v in query.items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            done = "code" in captured
            self.wfile.write(
                b"<h2>Strava authorized. Close this tab.</h2>"
                if done
                else b"<h2>Authorization failed. Check the terminal.</h2>"
            )

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            pass  # the CLI does the reporting

    server = HTTPServer((CALLBACK_HOST, port), Handler)
    print(f"Opening a browser to authorize scopes: {SCOPES}")
    print(f"If it does not open, visit:\n\n  {url}\n")
    webbrowser.open(url)
    server.handle_request()  # exactly one: the callback, then done
    server.server_close()

    if "code" not in captured:
        raise StravaError(
            f"No authorization code came back (got {captured or 'nothing'}). "
            "If this says 'redirect_uri mismatch', set the Authorization Callback "
            f"Domain to '{CALLBACK_HOST}' at https://www.strava.com/settings/api"
        )
    granted = set(captured.get("scope", "").split(","))
    if "activity:read_all" not in granted:
        # Loud, not a shrug: a grant missing this scope hides private activities,
        # and the resulting archive would look complete while being wrong.
        raise StravaError(
            f"Granted scopes {sorted(granted)} exclude activity:read_all. "
            "Re-run and tick every box on the Strava consent screen."
        )

    payload, _ = _request(
        TOKEN_URL,
        data=urllib.parse.urlencode(
            {
                "client_id": creds["client_id"],
                "client_secret": creds["client_secret"],
                "code": captured["code"],
                "grant_type": "authorization_code",
            }
        ).encode(),
    )
    creds["access_token"] = payload["access_token"]
    creds["refresh_token"] = payload["refresh_token"]
    creds["expires_at"] = (
        datetime.fromtimestamp(int(payload["expires_at"]), UTC).isoformat().replace("+00:00", "Z")
    )
    creds["scope"] = captured.get("scope", SCOPES)
    write_creds(creds_path, account, creds)
    return creds


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS activity (
    id                INTEGER PRIMARY KEY,
    started_at        TEXT NOT NULL,
    name              TEXT,
    activity_type     TEXT,
    summary_json      TEXT NOT NULL,
    detail_json       TEXT,
    indexed_at        TEXT NOT NULL,
    detail_fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS activity_pending ON activity (detail_fetched_at, started_at DESC);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def open_cache(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def meta_get(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def meta_set(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(value)),
    )


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _blob(payload: dict[str, Any]) -> str:
    """The response, whole and verbatim — narrowing happens at export, not here."""
    return json.dumps(payload, separators=(",", ":"))


def store_summaries(conn: sqlite3.Connection, activities: list[dict[str, Any]]) -> int:
    """Insert summaries, never clobbering a detail already fetched."""
    new = 0
    for act in activities:
        cur = conn.execute(
            """
            INSERT INTO activity (id, started_at, name, activity_type, summary_json, indexed_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                summary_json = excluded.summary_json,
                name         = excluded.name,
                started_at   = excluded.started_at
            """,
            (
                int(act["id"]),
                act["start_date"],
                act.get("name"),
                act.get("sport_type") or act.get("type"),
                _blob(act),
                _now(),
            ),
        )
        new += 1 if cur.rowcount == 1 else 0
    conn.commit()
    return new


# ---------------------------------------------------------------------------
# Phase 1 — index
# ---------------------------------------------------------------------------


def sync_index(conn: sqlite3.Connection, client: Client, *, max_pages: int | None) -> None:
    """Page through the activity list. Resumable, and stable across runs.

    Strava paginates newest-first, so a naive `page=N` walk of a growing list
    would silently skip activities as new ones shift the window. The backfill
    therefore pins `before` to an anchor captured at the start and never moves
    it; only once the backfill completes does the tool switch to `after`-based
    incremental polling.
    """
    if meta_get(conn, "backfill_complete") != "1":
        anchor = meta_get(conn, "backfill_anchor")
        if anchor is None:
            anchor = str(int(time.time()))
            meta_set(conn, "backfill_anchor", anchor)
            meta_set(conn, "backfill_page", "1")
            conn.commit()
        page = int(meta_get(conn, "backfill_page", "1") or 1)
        pages_done = 0
        while max_pages is None or pages_done < max_pages:
            log.info("index: backfill page %d", page)
            batch = client.get(
                "/athlete/activities", before=int(anchor), page=page, per_page=PER_PAGE
            )
            if not batch:
                meta_set(conn, "backfill_complete", "1")
                conn.commit()
                log.info("index: backfill complete")
                break
            added = store_summaries(conn, batch)
            page += 1
            pages_done += 1
            meta_set(conn, "backfill_page", str(page))
            conn.commit()
            log.info("index: +%d new (%d in page)", added, len(batch))
        else:
            return  # hit max_pages mid-backfill; incremental waits its turn

    # Incremental: everything newer than the newest we hold.
    row = conn.execute("SELECT MAX(started_at) AS latest FROM activity").fetchone()
    after = 0
    if row and row["latest"]:
        after = int(datetime.fromisoformat(row["latest"].replace("Z", "+00:00")).timestamp())
    page = 1
    while True:
        log.info("index: incremental page %d (after %s)", page, after)
        batch = client.get("/athlete/activities", after=after, page=page, per_page=PER_PAGE)
        if not batch:
            break
        added = store_summaries(conn, batch)
        log.info("index: +%d new (%d in page)", added, len(batch))
        page += 1


# ---------------------------------------------------------------------------
# Phase 2 — detail
# ---------------------------------------------------------------------------


def pending_ids(conn: sqlite3.Connection, limit: int | None) -> list[int]:
    """Activities with no detail yet, newest first — recent training matters most."""
    sql = "SELECT id FROM activity WHERE detail_fetched_at IS NULL ORDER BY started_at DESC"
    if limit is not None:
        sql += f" LIMIT {int(limit)}"
    return [r["id"] for r in conn.execute(sql)]


def sync_details(conn: sqlite3.Connection, client: Client, *, limit: int | None) -> int:
    fetched = 0
    for activity_id in pending_ids(conn, limit):
        detail = client.get(f"/activities/{activity_id}", include_all_efforts="false")
        conn.execute(
            "UPDATE activity SET detail_json = ?, detail_fetched_at = ? WHERE id = ?",
            (_blob(detail), _now(), activity_id),
        )
        conn.commit()
        fetched += 1
        if fetched % 10 == 0:
            log.info("detail: %d fetched (%s)", fetched, client.budget.describe())
    return fetched


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

# One column per overall statistic. Named explicitly rather than derived from
# whatever keys happen to be present, so the Parquet schema is stable across
# runs even though Strava's payload varies by activity type (a swim carries no
# watts, a treadmill run no speed).
NUMERIC = [
    "distance",
    "moving_time",
    "elapsed_time",
    "total_elevation_gain",
    "elev_high",
    "elev_low",
    "average_speed",
    "max_speed",
    "average_cadence",
    "average_temp",
    "average_watts",
    "max_watts",
    "weighted_average_watts",
    "kilojoules",
    "average_heartrate",
    "max_heartrate",
    "calories",
    "suffer_score",
    "perceived_exertion",
    "achievement_count",
    "kudos_count",
    "athlete_count",
    "pr_count",
]
BOOLEAN = ["trainer", "commute", "manual", "private", "device_watts", "has_heartrate"]
TEXT = ["gear_id", "device_name", "timezone", "workout_type", "description"]


def export(conn: sqlite3.Connection, out: Path) -> pl.DataFrame:
    records = []
    for row in conn.execute("SELECT * FROM activity ORDER BY started_at"):
        # Detail wins where present; summary is the floor. An activity is worth
        # exporting the moment it is indexed — waiting for its detail would make
        # a half-finished trickle export nothing at all.
        source = json.loads(row["detail_json"] or row["summary_json"])
        started = datetime.fromisoformat(str(source["start_date"]).replace("Z", "+00:00"))
        record: dict[str, Any] = {
            "activity_id": int(source["id"]),
            "started_at": started.replace(tzinfo=None),
            "date": started.date(),
            "start_date_local": str(source.get("start_date_local") or "")[:19] or None,
            "name": source.get("name"),
            "activity_type": source.get("sport_type") or source.get("type"),
            "has_detail": row["detail_json"] is not None,
        }
        for key in NUMERIC:
            value = source.get(key)
            record[key] = float(value) if isinstance(value, (int, float)) else None
        for key in BOOLEAN:
            value = source.get(key)
            record[key] = bool(value) if isinstance(value, bool) else None
        for key in TEXT:
            value = source.get(key)
            record[key] = str(value) if value is not None else None
        records.append(record)
    if not records:
        raise StravaError("Nothing cached yet — run `make strava-pull` first")
    # Declared, not inferred. Polars infers from the first 100 rows, and a column
    # that is null across all of them (`average_watts` for a decade of runs) is
    # typed Null — then the first real value further down fails to append. The
    # column list is already explicit above; the types have to be too.
    schema = {
        "activity_id": pl.Int64,
        "started_at": pl.Datetime,
        "date": pl.Date,
        "start_date_local": pl.Utf8,
        "name": pl.Utf8,
        "activity_type": pl.Utf8,
        "has_detail": pl.Boolean,
        **{key: pl.Float64 for key in NUMERIC},
        **{key: pl.Boolean for key in BOOLEAN},
        **{key: pl.Utf8 for key in TEXT},
    }
    frame = pl.DataFrame(records, schema=schema)
    out.parent.mkdir(parents=True, exist_ok=True)
    frame.write_parquet(out)
    return frame


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def _counts(conn: sqlite3.Connection) -> tuple[int, int]:
    row = conn.execute(
        "SELECT COUNT(*) AS total, COUNT(detail_fetched_at) AS detailed FROM activity"
    ).fetchone()
    return row["total"], row["detailed"]


def cmd_status(args: argparse.Namespace) -> None:
    account = resolve_account(args.creds, args.account)
    conn = open_cache(cache_path(args, account))
    total, detailed = _counts(conn)
    backfill = "complete" if meta_get(conn, "backfill_complete") == "1" else "in progress"
    print(f"account           {account}")
    print(f"cache             {cache_path(args, account)}")
    print(f"activities        {total} indexed, {detailed} detailed, {total - detailed} pending")
    print(f"index backfill    {backfill}")
    if total:
        span = conn.execute("SELECT MIN(started_at) a, MAX(started_at) b FROM activity").fetchone()
        print(f"span              {span['a'][:10]} .. {span['b'][:10]}")
        by_type = conn.execute(
            "SELECT activity_type, COUNT(*) n FROM activity GROUP BY 1 ORDER BY n DESC LIMIT 8"
        ).fetchall()
        print("types             " + ", ".join(f"{r['activity_type']} {r['n']}" for r in by_type))
    creds = read_creds(args.creds, account)
    expiry = _expiry(creds)
    live = expiry is not None and expiry - TOKEN_SKEW > datetime.now(UTC)
    state = f"valid until {expiry.isoformat()}" if live and expiry else "stale, will refresh"
    print(f"access token      {state}")
    scope = creds.get("scope")
    if scope is None:
        print("scope             unknown — run `auth login` if requests come back 401")
    else:
        ok = "activity:read_all" in scope.split(",")
        print(f"scope             {scope}{'' if ok else '  ** missing activity:read_all **'}")
    pending = total - detailed
    if pending:
        # Estimated from the limit Strava last reported, not a constant: the
        # per-app tier can be raised, and a hardcoded figure would quietly
        # keep quoting the old one.
        per_window = int(meta_get(conn, "read_limit_15min") or 0)
        if per_window:
            batches = -(-pending // max(1, per_window - DEFAULT_RESERVE_15MIN))
            print(f"\n{pending} details left: about {batches} batch(es) of "
                  f"{per_window - DEFAULT_RESERVE_15MIN}, 15 minutes apart.")
        else:
            print(f"\n{pending} details left; run `pull` to learn the rate limit tier.")


def cmd_auth_login(args: argparse.Namespace) -> None:
    account = resolve_account(args.creds, args.account)
    creds = authorize(args.creds, account, port=args.port)
    print(f"[{account}] authorized; scope={creds['scope']} expires_at={creds['expires_at']}")


def cmd_auth_refresh(args: argparse.Namespace) -> None:
    account = resolve_account(args.creds, args.account)
    client = Client(args.creds, account, Budget(0, 0))
    client.refresh()
    print(f"[{account}] refreshed; expires_at={client.creds['expires_at']}")


def cmd_pull(args: argparse.Namespace) -> None:
    account = resolve_account(args.creds, args.account)
    conn = open_cache(cache_path(args, account))
    budget = Budget(args.reserve, args.reserve_daily)
    client = Client(args.creds, account, budget)
    before_total, before_detailed = _counts(conn)
    stopped = None
    try:
        if not args.details_only:
            sync_index(conn, client, max_pages=args.max_pages)
        if not args.index_only:
            sync_details(conn, client, limit=args.limit)
    except BudgetExhausted as exc:
        stopped = str(exc)
    if budget.limit_15:
        # Remembered so `status` can estimate remaining batches without spending
        # a request to rediscover the tier.
        meta_set(conn, "read_limit_15min", str(budget.limit_15))
        conn.commit()
    total, detailed = _counts(conn)
    print(
        f"indexed +{total - before_total} (total {total}), "
        f"detailed +{detailed - before_detailed} (total {detailed}), "
        f"{total - detailed} pending"
    )
    print(budget.describe())
    if stopped:
        print(f"stopped early: {stopped}. Re-run to continue — nothing is lost.")
    elif total == detailed and meta_get(conn, "backfill_complete") == "1":
        print("complete: every activity is indexed and detailed.")


def cmd_export(args: argparse.Namespace) -> None:
    account = resolve_account(args.creds, args.account)
    conn = open_cache(cache_path(args, account))
    out = args.out or STRAVA_DIR / f"{account}-activities.parquet"
    frame = export(conn, out)
    partial = int(frame.filter(~pl.col("has_detail")).height)
    print(f"wrote {out} — {frame.height} activities, {len(frame.columns)} columns")
    if partial:
        print(f"note: {partial} row(s) are summary-only (no detail fetched yet)")


def cache_path(args: argparse.Namespace, account: str) -> Path:
    """One cache per account — two athletes' archives must never share a file."""
    return args.cache or STRAVA_DIR / f"{account}.sqlite"


def build_parser() -> argparse.ArgumentParser:
    def _help(p: argparse.ArgumentParser):
        def _print_help(_: argparse.Namespace) -> None:
            p.print_help()

        return _print_help

    parser = argparse.ArgumentParser(
        prog="strava",
        description="Resumable, rate-limit-aware extract of the full Strava activity history.",
    )
    parser.add_argument(
        "--account", default=None, help="Which [section] of the creds file to use"
    )
    parser.add_argument(
        "--cache", type=Path, default=None, help="Override the per-account cache path"
    )
    parser.add_argument("--creds", type=Path, default=DEFAULT_CREDS)
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.set_defaults(func=_help(parser))
    sub = parser.add_subparsers(dest="command", required=False)

    sub.add_parser("status", help="Show cache coverage and token state").set_defaults(func=cmd_status)

    auth = sub.add_parser("auth", help="Authorize the app, or refresh the access token")
    auth.set_defaults(func=_help(auth))
    auth_sub = auth.add_subparsers(dest="auth_cmd", required=False)
    login = auth_sub.add_parser("login", help="Mint a fresh grant via the browser consent screen")
    login.add_argument("--port", type=int, default=CALLBACK_PORT)
    login.set_defaults(func=cmd_auth_login)
    auth_sub.add_parser("refresh", help="Exchange the refresh token for a new access token").set_defaults(
        func=cmd_auth_refresh
    )

    pull = sub.add_parser("pull", help="Run one trickle batch, bounded by the read budget")
    pull.add_argument("--limit", type=int, default=None, help="Cap detail fetches this batch")
    pull.add_argument("--max-pages", type=int, default=None, help="Cap index pages this batch")
    pull.add_argument("--index-only", action="store_true")
    pull.add_argument("--details-only", action="store_true")
    pull.add_argument("--reserve", type=int, default=DEFAULT_RESERVE_15MIN)
    pull.add_argument("--reserve-daily", type=int, default=DEFAULT_RESERVE_DAILY)
    pull.set_defaults(func=cmd_pull)

    exp = sub.add_parser("export", help="Write the cache to Parquet")
    exp.add_argument("--out", type=Path, default=None)
    exp.set_defaults(func=cmd_export)

    return parser


def main() -> None:
    args = build_parser().parse_args()
    logging.basicConfig(
        level=logging.DEBUG if getattr(args, "verbose", False) else logging.INFO,
        format="%(message)s",
    )
    try:
        args.func(args)
    except StravaError as exc:
        raise SystemExit(f"error: {exc}") from exc


if __name__ == "__main__":
    main()
