# Heebo Scraper Server (personal use)

Node.js micro-service that runs `israeli-bank-scrapers` to pull transactions and
balances from Israeli banks and credit card companies. Called by the
`bank-scraper-proxy` Supabase Edge Function.

## Personal use only — this is screen scraping, not open banking

This service logs into the bank's *consumer website* with your own credentials
and reads the pages, exactly as you would in a browser. It is **not** a
regulated Israeli open-banking integration, and it must only be used for your
own accounts with your own consent.

Practical consequences:

- Bank websites change without notice, so a scrape can break at any time.
- Some banks lock or challenge automated logins; a failed sync may require you
  to log in manually or re-enter credentials.
- Where the bank offers a read-only / viewer password, use that one.
- Never point this service at accounts that are not yours.

## Why a separate server?

`israeli-bank-scrapers` uses Puppeteer (headless Chromium). Puppeteer cannot
run inside Supabase Edge Functions (Deno), so the scraping must live on a
regular Node.js host.

## Runtime requirements

- Node.js **>= 22.22.2** (enforced via `engines.node`).
- `israeli-bank-scrapers` is pinned to exactly **6.8.0**, which depends on
  Puppeteer `^24.40.0`; the Docker base image is pinned to the matching
  `ghcr.io/puppeteer/puppeteer:24.40.0` so the bundled Chromium stays in sync.

## Always-on requirement (daily morning sync)

The scheduled **daily morning sync** calls `bank-scraper-proxy`, which in turn
calls this service over HTTPS. The service therefore has to be reachable at the
scheduled time every day:

- Deploy it on a host that does **not** sleep or scale to zero on idle
  (e.g. Render/Railway always-on instances, Fly.io with `min_machines_running = 1`,
  or a VPS with a systemd / Docker `restart: always` policy).
- A cold, sleeping instance makes the morning sync fail rather than merely run
  late — the Edge Function has a request timeout and does not retry forever.
- Keep `GET /health` reachable to an uptime monitor so you learn about an
  outage before the sync silently stops producing transactions.
- Scraping one bank takes tens of seconds of Chromium time; size the instance
  with at least ~1 GB RAM and let concurrent runs queue.


## API

The API is **server-to-server only**. No CORS headers are emitted and any
request that carries an `Origin` header (i.e. a browser) is rejected with
`403`. Call it from the `bank-scraper-proxy` Edge Function, never from the web
app.

### `POST /scrape`

Headers:
- `X-API-Key: <SCRAPER_API_KEY>`
- `Content-Type: application/json`


Body:
```json
{
  "bank_type": "hapoalim",
  "credentials": { "userCode": "...", "password": "..." },
  "start_date": "2026-01-01"
}
```

Response:
```json
{
  "success": true,
  "balance": 12345.67,
  "accounts": [{ "account_number": "123-456", "balance": 12345.67, "txns_count": 42 }],
  "transactions": [
    {
      "account_number": "123-456",
      "identifier": "abc",
      "date": "2026-03-15T00:00:00.000Z",
      "charged_amount": -250,
      "original_amount": -250,
      "original_currency": "ILS",
      "description": "שופרסל",
      "status": "completed",
      "type": "normal"
    }
  ]
}
```

### `POST /otp/one-zero/start`

Server-to-server only (same `X-API-Key`, `Origin` refused, rate limited to
10 requests / 5 minutes). Starts the one-time ONE ZERO SMS flow.

```json
{ "phone_number": "+972501234567" }
```

Response: `{ "success": true, "session_id": "<opaque hex>", "expires_in_seconds": 600 }`.

The live scraper instance holding the OTP context is kept **in memory only**,
keyed by `session_id`, expires after 10 minutes, and the number of outstanding
sessions is capped. The phone number is never logged or echoed.

### `POST /otp/one-zero/verify`

```json
{ "session_id": "<from start>", "otp_code": "123456" }
```

Response: `{ "success": true, "otp_long_term_token": "<token>" }`. The session is
destroyed immediately after a successful verification. This is the single
required handoff of the token to the trusted Edge Function; the OTP code itself
is never logged or echoed.

### `GET /health`

Returns `{ "status": "ok", "uptime": <seconds> }`.


## Environment variables

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `SCRAPER_API_KEY` | Yes | — | Shared secret. Must match the `SCRAPER_API_KEY` set on the `bank-scraper-proxy` Supabase function. |
| `PORT` | No | `3000` | HTTP port |
| `DEFAULT_START_DAYS` | No | `60` | How many days back to scrape when `start_date` not provided |

## Deploy

### Railway / Render / Fly.io
1. Create a new service from this directory.
2. Set build command: `npm install`
3. Set start command: `npm start`
4. Set env var `SCRAPER_API_KEY` to a long random string.
5. For Railway/Render you must use the Dockerfile (Puppeteer requires Chromium).

### Docker
```bash
docker build -t heebo-scraper .
docker run -p 3000:3000 -e SCRAPER_API_KEY=<secret> heebo-scraper
```

### Local development
```bash
cp .env.example .env
# edit .env
npm install
npm run dev
```

## Wire it up

After deploying, set these secrets on the Supabase project so that the
`bank-scraper-proxy` Edge Function can reach the scraper:

```bash
supabase secrets set SCRAPER_SERVER_URL=https://<your-deploy-url>
supabase secrets set SCRAPER_API_KEY=<same-secret-as-above>
```

## Security notes

- Credentials are transient: they exist only for the lifetime of one `/scrape`
  request. They are never written to disk, never logged, and never echoed back
  in a response — error messages are scrubbed of any credential value before
  being returned or logged.
- No browser CORS exposure: `cors()` is not installed, no
  `Access-Control-Allow-Origin` is sent, and requests with an `Origin` header
  are refused. The only intended caller is the Edge Function.
- `X-API-Key` is compared in constant time and must be at least 24 characters;
  the process refuses to start without it.
- `helmet()` is enabled and the JSON body limit is 256 kB.
- Rate limited to 30 requests / 5 minutes per IP.
- Use HTTPS in production (Railway / Render / Fly.io provide TLS automatically).
- Rotate `SCRAPER_API_KEY` periodically.
- Restrict the deployed host's inbound traffic to Supabase's IP range if your
  provider supports it.


## Supported bank types

| UI `bank_type` | Scraper `companyId` | Required credentials |
|----------------|--------------------|----------------------|
| `hapoalim` | `hapoalim` | `userCode`, `password` |
| `hapoalimBeOnline` | `hapoalim` | `userCode`, `password` |
| `leumi` | `leumi` | `username`, `password` |
| `discount` | `discount` | `id`, `password`, `num` |
| `mercantile` | `mercantile` | `id`, `password`, `num` |
| `mizrahi` | `mizrahi` | `username`, `password` |
| `otsarHahayal` | `otsarHahayal` | `username`, `password` |
| `beyondBenleumi` | `beinleumi` | `username`, `password` |
| `massad` | `massad` | `username`, `password` |
| `yahav` | `yahav` | `username`, `password`, `nationalID` |
| `jerusalem` | `jerusalem` | `username`, `password` |
| `oneZero` | `oneZero` | `email`, `password`, `otpLongTermToken` (see below) |
| `cal` | `visaCal` | `username`, `password` |
| `max` | `max` | `username`, `password` |
| `isracard` | `isracard` | `id`, `card6Digits`, `password` |
| `amex` | `amex` | `username`, `card6Digits`, `password` |

### ONE ZERO: the one-time SMS step

ONE ZERO does not accept an email + password login for automation. It requires a
**long-term OTP token**, which is minted once from a code sent by SMS:

1. In the app, choose ONE ZERO and enter the account email and password.
2. Enter the mobile phone number registered with ONE ZERO and press "שלח קוד".
   The Edge Function calls `POST /otp/one-zero/start`, and ONE ZERO texts a code.
3. Type the code from the SMS and press "אמת". The Edge Function calls
   `POST /otp/one-zero/verify`, which returns the long-term token.
4. The token is stored encrypted together with the email and password. The phone
   number and the SMS code are **not** stored anywhere.

This step is done once. Afterwards the daily morning sync runs unattended. If
ONE ZERO invalidates the token, repeat the step from the connection card's key
icon ("עדכון פרטי התחברות").



## Daily morning sync

The protected Supabase scheduler draft runs every morning at 06:30 in the
`Asia/Jerusalem` timezone. This scraper service must be hosted on an always-on
Node.js service and reachable over HTTPS. The database cron job calls the Edge
Function; it never calls this service directly.

Automatic scraping is best-effort. A provider that requires an interactive OTP
or changes its login page will be marked as failed without blocking the other
connections. A second protected attempt at 06:45 runs only when the first one
did not succeed. Re-enter credentials from the app and retry manually when
needed.

### Activate only after preview verification

The draft stays inactive until all of the following are completed intentionally:

1. Deploy the always-on scraper service and set its `SCRAPER_API_KEY`.
2. Apply the Cash Flow migrations, including `20260802163000_daily_bank_sync.sql`.
3. Set the Edge Function secrets `SCRAPER_SERVER_URL`, `SCRAPER_API_KEY`,
   `BANK_SYNC_CRON_SECRET` and the existing credential-encryption key.
4. Store the project URL as `project_url` and the same high-entropy cron secret
   as `bank_sync_cron_secret` in Supabase Vault.
5. Deploy `bank-scraper-proxy`, then activate the job once with:
   `select public.schedule_daily_bank_sync();`

The Edge Function imports transactions idempotently, so retries do not create
duplicates. A failure in one provider does not stop the remaining connections.
This is personal-use screen scraping, not regulated open banking.
