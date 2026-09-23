# AbaCast Model Lab

A standalone Cloudflare experiment that feeds the **same live Plano, Texas weather fixture** to three low-cost AI models and displays their responses side by side.

This project is intentionally isolated from the production AbaWeather app and backend. It does not call, modify, or depend on AbaWeather's production `/abacast` endpoint.

## What it does

Every experiment:

1. Resolves the fixed Plano point through the National Weather Service API.
2. Checks the nearest five NWS stations and uses the first recent, valid observation, matching the production AbaCast path.
3. Fetches the point-specific next 8 hourly forecast periods and formats them with the same daypart wording used by the app.
4. Fetches the latest NWS Area Forecast Discussion for the point's WFO.
5. Extracts only the **SHORT TERM** AFD section when available.
6. Freezes that weather input and the current AbaCast system prompt.
7. Sends the identical prompt + input to:
   - OpenAI GPT-5.6 Luna
   - Anthropic Claude Haiku 4.5
   - Google Gemini 3.5 Flash-Lite
8. Stores the fixture, raw model outputs, latency, token usage, prompt-compliance stats, and estimated API cost in Cloudflare D1.
9. Serves the dashboard and history from the same standalone Worker.

Model output is deliberately **not rewritten or normalized** in the lab. The point is to see how each model obeys the same instructions on its own.

## Architecture

```text
QStash every 15 min ──────┐
                          ├── POST /api/generate
Manual dashboard button ──┘        │
                                   ├── NWS /points
                                   ├── NWS observation
                                   ├── NWS hourly forecast
                                   ├── NWS SHORT TERM AFD
                                   │
                                   ├── OpenAI
                                   ├── Anthropic
                                   └── Gemini
                                          │
                                          ▼
                                     Cloudflare D1
                                          │
                                          ▼
Browser ─────────────── GET /api/latest + /api/history
```

Normal page loads **never invoke an AI model**. They only read previously stored experiments from D1.

## Cloudflare setup

The folder is a complete standalone Worker project. If this is later moved into its own GitHub repository, copy the contents of `abacast-lab/` to the new repository root.

If deploying directly from this repository using Cloudflare's Git integration, set the project root directory to:

```text
abacast-lab
```

### 1. Install dependencies

```bash
npm install
```

### 2. Create the D1 database

```bash
npx wrangler d1 create abacast-model-lab
```

Cloudflare will return a database ID. Replace:

```text
REPLACE_WITH_D1_DATABASE_ID
```

in `wrangler.jsonc`.

### 3. Apply the database migration

```bash
npm run d1:migrate:remote
```

For local development:

```bash
npm run d1:migrate:local
```

### 4. Add Worker secrets

Set each secret through Wrangler or the Cloudflare dashboard:

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GENERATE_SECRET
npx wrangler secret put RATE_LIMIT_SALT
```

- `OPENAI_API_KEY`: OpenAI developer API key.
- `ANTHROPIC_API_KEY`: Anthropic developer API key.
- `GEMINI_API_KEY`: Google Gemini Developer API key.
- `GENERATE_SECRET`: a new random secret used only by QStash to invoke the scheduled generation endpoint.
- `RATE_LIMIT_SALT`: a random value used before hashing client IPs for manual-run rate limiting. Raw IP addresses are never written to D1.

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in test values. `.dev.vars` is ignored by Git.

### 5. Deploy

```bash
npm run deploy
```

The Worker serves both the dashboard and its API from the same origin.

## QStash schedule

Create a separate QStash schedule that sends a **POST every 15 minutes** to:

```text
https://YOUR-LAB-WORKER.workers.dev/api/generate
```

Add this header:

```text
Authorization: Bearer YOUR_GENERATE_SECRET
```

Use a **new secret dedicated to this lab** rather than reusing any AbaWeather production secret.

Scheduled requests are bucketed into 15-minute windows. If QStash retries the same window, the Worker reuses the stored experiment instead of intentionally running all three models twice. A stale generation lock can be reclaimed after two minutes.

## Manual refresh protection

The public **Run New Experiment** button calls `POST /api/manual-run`.

Default limits:

- 1 successful attempt per client IP every 60 seconds.
- At most 1 manual experiment globally every 30 seconds.
- IPs are salted and SHA-256 hashed before storage.
- The browser must send a lab-specific request header for manual runs; cross-origin browser requests are not enabled.
- Scheduled QStash runs bypass the public manual rate limiter.

All limits can be adjusted in `wrangler.jsonc`.

## History

D1 retains experiments for 30 days by default. The dashboard displays the latest 20 and allows visitors to reopen prior tests without calling any AI provider.

## API

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/` | GET | Dashboard |
| `/api/health` | GET | Service/provider configuration status |
| `/api/latest` | GET | Latest stored experiment |
| `/api/history?limit=20` | GET | Recent experiment summaries |
| `/api/experiments/:id` | GET | One complete historical experiment |
| `/api/manual-run` | POST | Rate-limited public experiment run |
| `/api/generate` | POST | QStash-only scheduled run; Bearer secret required |

## Models

Defaults are configurable in `wrangler.jsonc`:

```text
OpenAI:    gpt-5.6-luna
Anthropic: claude-haiku-4-5-20251001
Google:    gemini-3.5-flash-lite
```

The Google model is the current stable Flash-Lite generation rather than the older Gemini 2.5 model. The Anthropic model uses the pinned Haiku 4.5 version so the experiment does not silently change underneath us. Anthropic currently lists this specific version as active with a tentative retirement no sooner than October 15, 2026, so the `ANTHROPIC_MODEL` variable is intentionally easy to swap when a newer low-cost Claude model is appropriate.

Estimated per-run cost shown in the UI is calculated from token usage using list pricing recorded on **2026-09-23**:

| Model | Input / 1M | Output / 1M |
| --- | ---: | ---: |
| GPT-5.6 Luna | $0.20 | $1.20 |
| Claude Haiku 4.5 | $1.00 | $5.00 |
| Gemini 3.5 Flash-Lite | $0.30 | $2.50 |

Gemini's estimate includes reported thinking tokens in the output-side estimate when Google returns them. Pricing is informational and should be updated if provider rates change.

## Weather fixture

Default fixed location:

```text
Plano, TX
33.0198, -96.6989
America/Chicago
```

The Worker resolves the NWS WFO dynamically from `/points` rather than hard-coding FWD. That keeps the experiment logic honest and makes changing the test location later trivial.

The current AbaCast system prompt is copied into this project so all three models receive exactly the same instructions. The local weather snapshot and AFD wrapper also intentionally mirror the production AbaCast input structure. Any future production prompt or input-format changes should be intentionally copied here when a new comparison is desired.

## Notes

- No provider API key is ever sent to browser JavaScript.
- Static responses carry clickjacking, MIME-sniffing, referrer, permissions, CSP, and no-index headers.
- No model call occurs just because somebody opens or refreshes the page.
- The dashboard shows raw responses and separately marks whether each result stayed within 135 characters and ended with an emoji.
- Provider failures are stored alongside successful results so partial experiments remain useful.
- The lab is not intended for life-safety weather guidance.
