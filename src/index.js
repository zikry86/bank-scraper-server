import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import { installOneZeroTransport } from './one-zero-transport.js';


/**
 * Personal-use screen-scraping service.
 *
 * SECURITY MODEL
 * --------------
 * - This service is called ONLY server-to-server by the trusted Supabase Edge
 *   Function `bank-scraper-proxy`. It is not a browser endpoint, therefore CORS
 *   is deliberately NOT enabled (no `Access-Control-Allow-Origin` is emitted),
 *   which blocks browser-originated calls.
 * - Credentials are transient: they exist only for the lifetime of a single
 *   request, are never written to disk, never cached, and never logged or
 *   echoed back in a response.
 * - Errors are sanitized before being returned so that no credential value can
 *   leak through a stack trace or a library error message.
 */

// Railway's public domain for this service is pinned to port 3001. Keep a
// dedicated override so the service is not moved when Railway injects PORT.
const PORT = process.env.SCRAPER_PORT || process.env.PORT || 3000;
const API_KEY = process.env.SCRAPER_API_KEY;
const DEFAULT_START_DAYS = Number(process.env.DEFAULT_START_DAYS || 60);
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--lang=he-IL',
  '--window-size=1365,900',
];

const BANK_BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

if (!API_KEY) {
  console.error('FATAL: SCRAPER_API_KEY env var is required');
  process.exit(1);
}
if (API_KEY.length < 24) {
  console.error('FATAL: SCRAPER_API_KEY must be at least 24 characters');
  process.exit(1);
}

const app = express();
// Railway terminates TLS in front of this process. Trust its single proxy hop
// so express-rate-limit uses the real client address without validation noise.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());
// NOTE: no `cors()` middleware on purpose — server-to-server only.
app.use(express.json({ limit: '256kb' }));

installOneZeroTransport();

// Rate limit by IP: 30 requests / 5 minutes
app.use(
  '/scrape',
  rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// OTP onboarding is interactive and rare: 10 requests / 5 minutes per IP.
app.use(
  '/otp',
  rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
  })
);


/** Constant-time-ish API key comparison. */
function apiKeyMatches(candidate) {
  if (typeof candidate !== 'string' || candidate.length !== API_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < API_KEY.length; i += 1) {
    diff |= candidate.charCodeAt(i) ^ API_KEY.charCodeAt(i);
  }
  return diff === 0;
}

function requireApiKey(req, res, next) {
  if (!apiKeyMatches(req.header('X-API-Key'))) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  // Browsers always send an Origin header on cross-origin requests; the Edge
  // Function (server-side fetch) does not. Reject browser-originated calls.
  if (req.header('Origin')) {
    return res.status(403).json({ error: 'Browser origins are not allowed' });
  }
  return next();
}

// Supported bank types - must match israeli-bank-scrapers CompanyTypes
const SUPPORTED_COMPANIES = new Set(Object.values(CompanyTypes));

// Per-bank credential schemas. Keys must match CompanyTypes.
const credentialsSchemas = {
  hapoalim: z.object({ userCode: z.string().min(1), password: z.string().min(1) }),
  leumi: z.object({ username: z.string().min(1), password: z.string().min(1) }),
  discount: z.object({
    id: z.string().min(1),
    password: z.string().min(1),
    num: z.string().min(1),
  }),
  mercantile: z.object({
    id: z.string().min(1),
    password: z.string().min(1),
    num: z.string().min(1),
  }),
  mizrahi: z.object({ username: z.string().min(1), password: z.string().min(1) }),
  otsarHahayal: z.object({ username: z.string().min(1), password: z.string().min(1) }),
  beinleumi: z.object({ username: z.string().min(1), password: z.string().min(1) }),
  massad: z.object({ username: z.string().min(1), password: z.string().min(1) }),
  yahav: z.object({
    username: z.string().min(1),
    password: z.string().min(1),
    nationalID: z.string().min(1),
  }),
  jerusalem: z.object({ username: z.string().min(1), password: z.string().min(1) }),
  unionBank: z.object({ username: z.string().min(1), password: z.string().min(1) }),
  oneZero: z.object({
    email: z.string().email(),
    password: z.string().min(1),
    otpLongTermToken: z.string().min(1),
  }),
  visaCal: z.object({ username: z.string().min(1), password: z.string().min(1) }),
  max: z.object({ username: z.string().min(1), password: z.string().min(1) }),
  isracard: z.object({
    id: z.string().min(1),
    card6Digits: z.string().min(6).max(6),
    password: z.string().min(1),
  }),
  amex: z.object({
    username: z.string().min(1),
    card6Digits: z.string().min(6).max(6),
    password: z.string().min(1),
  }),
  behatsdaa: z.object({ username: z.string().min(1), password: z.string().min(1) }),
};

// Legacy alias mapping: UI sends these names, israeli-bank-scrapers expects CompanyTypes values.
const bankTypeAliases = {
  cal: 'visaCal',
  beyondBenleumi: 'beinleumi',
  hapoalimBeOnline: 'hapoalim',
};

function normalizeBankType(bankType) {
  return bankTypeAliases[bankType] || bankType;
}

/**
 * Give cloud-hosted Chromium the same basic browser profile as a normal
 * Hebrew desktop session. This reduces false automation blocks without
 * bypassing authentication, CAPTCHAs or two-factor challenges.
 */
async function prepareBankPage(page) {
  await page.setUserAgent(BANK_BROWSER_USER_AGENT);
  await page.setViewport({ width: 1365, height: 900, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({
    'accept-language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      configurable: true,
      get: () => undefined,
    });
    Object.defineProperty(navigator, 'languages', {
      configurable: true,
      get: () => ['he-IL', 'he', 'en-US', 'en'],
    });
  });
}

/**
 * FIBI no longer accepts a cold navigation to its legacy login servlet.
 * The same servlet is still used, but only as an iframe opened from the
 * public website, which establishes the required browser context first.
 *
 * Keep this adapter local to FIBI so the other Beinleumi-group scrapers retain
 * their upstream login flows. No credentials are inspected or persisted here.
 */
function applyFibiEmbeddedLogin(scraper) {
  const getOriginalLoginOptions = scraper.getLoginOptions.bind(scraper);

  scraper.getLoginOptions = (credentials) => {
    const original = getOriginalLoginOptions(credentials);
    let loginFrame;
    let loginReady = false;

    const possibleResults = {
      ...original.possibleResults,
      SUCCESS: [
        async () => loginReady,
        ...(original.possibleResults?.SUCCESS || []),
      ],
    };

    return {
      ...original,
      loginUrl: 'https://www.fibi.co.il/private/',
      possibleResults,
      checkReadiness: async () => {
        const page = scraper.page;
        if (!page) throw new Error('FIBI login page was not initialized');

        await page.waitForSelector('.login-trigger', { visible: true });
        await page.$eval('.login-trigger', (button) => button.click());

        const iframeElement = await page.waitForSelector('iframe#loginFrame', {
          visible: true,
        });
        loginFrame = await iframeElement.contentFrame();
        if (!loginFrame) throw new Error('FIBI login frame was not available');

        try {
          await loginFrame.waitForSelector('#continueBtn', { visible: true });
        } catch {
          const rawUrl = loginFrame.url();
          let safePath = 'unknown';
          try {
            const parsedUrl = new URL(rawUrl);
            safePath = `${parsedUrl.origin}${parsedUrl.pathname}`;
          } catch {
            // Keep the diagnostic value generic if the frame URL is malformed.
          }
          const rawTitle = await loginFrame.title().catch(() => '');
          const safeTitle = rawTitle.replace(/[\\r\\n\\t]/g, ' ').slice(0, 80) || 'unknown';
          throw new Error(
            `FIBI login form unavailable (title: ${safeTitle}, page: ${safePath})`
          );
        }
      },
      submitButtonSelector: async () => {
        if (!loginFrame) throw new Error('FIBI login frame was not available for submit');
        // The current control is an <input type="button"> whose login handler
        // expects a real browser mouse event. Calling element.click() inside the
        // page creates a synthetic event and leaves the iframe on the login
        // servlet. Puppeteer's Frame.click sends the trusted mouse sequence.
        await loginFrame.click('#continueBtn');
      },
      preAction: async () => {
        // FIBI's embedded form ignores an immediate programmatic click even
        // after the submit button is visible. Preserve the upstream delay.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return loginFrame;
      },
      postAction: async () => {
        const page = scraper.page;
        if (!page) throw new Error('FIBI post-login page was not initialized');

        const deadline = Date.now() + 120_000;
        const readyUrl =
          /fibi.*accountSummary|Resources\/PortalNG\/shell|FibiMenu\/Online/i;
        const readySelectors = [
          '#card-header',
          '#account_num',
          '#matafLogoutLink',
          '#validationMsg',
        ];

        const getOpenPages = async () => {
          const pages = await page.browser().pages().catch(() => []);
          return pages.length > 0 ? pages : [page];
        };

        while (Date.now() < deadline) {
          const openPages = await getOpenPages();
          for (const openPage of openPages) {
            const targets = [openPage, ...openPage.frames()];
            for (const target of targets) {
              if (readyUrl.test(target.url())) {
                // FIBI may open the authenticated portal in a new tab. Keep
                // that page as the scraper's active page so fetchData() uses
                // the authenticated browser context and the correct tab.
                scraper.page = openPage;
                loginReady = true;
                return;
              }

              for (const selector of readySelectors) {
                if (await target.$(selector).catch(() => null)) {
                  scraper.page = openPage;
                  loginReady = true;
                  return;
                }
              }
            }
          }

          if (loginFrame) {
            const loginRejected = await loginFrame
              .$eval('#mymessage', (element) => Boolean(element.textContent?.trim()))
              .catch(() => false);
            if (loginRejected) {
              throw new Error(
                'FIBI did not complete login; verify the saved credentials or bank challenge'
              );
            }
          }

          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        const safeLocation = (rawUrl) => {
          try {
            const parsedUrl = new URL(rawUrl);
            return parsedUrl.origin === 'null'
              ? `${parsedUrl.protocol}${parsedUrl.pathname}`
              : `${parsedUrl.origin}${parsedUrl.pathname}`;
          } catch {
            return 'unknown';
          }
        };
        const openPages = await getOpenPages();
        const locations = [
          ...new Set(
            openPages
              .flatMap((openPage) => [openPage, ...openPage.frames()])
              .slice(0, 12)
              .map((target) => safeLocation(target.url()))
          ),
        ];
        throw new Error(
          `FIBI post-login page did not become ready (locations: ${locations.join(', ')})`
        );
      },
    };
  };
}

const scrapeBodySchema = z.object({
  bank_type: z.string().min(1),
  credentials: z.record(z.string()),
  start_date: z.string().optional(), // ISO date, inclusive lower bound
});

/**
 * Removes any credential value that might have been interpolated into an error
 * message by the scraping library or by Puppeteer.
 */
function sanitizeMessage(message, secrets) {
  let out = typeof message === 'string' ? message : 'Unknown error';
  for (const secret of secrets) {
    if (secret && secret.length >= 3) {
      out = out.split(secret).join('***');
    }
  }
  return out.slice(0, 500);
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

/* ------------------------------------------------------------------ *
 * ONE ZERO two-factor onboarding
 * ------------------------------------------------------------------ *
 * ONE ZERO cannot be scraped with email+password alone: it requires a
 * long-term OTP token that is minted once, interactively, from an SMS code.
 * These two endpoints let the trusted Edge Function drive that one-time
 * flow on behalf of an authenticated user.
 *
 * Hard rules:
 *  - The live scraper instance (which holds the transient `otpContext`)
 *    lives ONLY in this process's memory, keyed by an opaque session id.
 *  - Sessions expire after 10 minutes and the number of outstanding
 *    sessions is capped.
 *  - The phone number, the OTP code and the resulting long-term token are
 *    never logged and never echoed back except for the single required
 *    token handoff in the verify response.
 */

const OTP_SESSION_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_SESSIONS = 25;

/** sessionId -> { scraper, expiresAt } */
const otpSessions = new Map();

function purgeExpiredOtpSessions() {
  const now = Date.now();
  for (const [id, session] of otpSessions) {
    if (session.expiresAt <= now) otpSessions.delete(id);
  }
}

// E.164: leading +, country code, 7..14 more digits.
const otpStartSchema = z.object({
  phone_number: z.string().regex(/^\+[1-9]\d{7,14}$/),
});

const otpVerifySchema = z.object({
  session_id: z.string().regex(/^[0-9a-f]{32,64}$/),
  otp_code: z.string().regex(/^\d{4,10}$/),
});

/** Generic, value-free error text — never surfaces phone/OTP/token. */
function otpErrorText(err) {
  const raw = err instanceof Error ? err.message : '';
  return raw && raw.length < 200 ? 'OTP request failed' : 'OTP request failed';
}

app.post('/otp/one-zero/start', requireApiKey, async (req, res) => {
  const parsed = otpStartSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_phone_number' });
  }

  purgeExpiredOtpSessions();
  if (otpSessions.size >= OTP_MAX_SESSIONS) {
    return res.status(429).json({ error: 'too_many_otp_sessions' });
  }

  try {
    const scraper = createScraper({
      companyId: CompanyTypes.oneZero,
      startDate: new Date(Date.now() - DEFAULT_START_DAYS * 24 * 60 * 60 * 1000),
      showBrowser: false,
      verbose: false,
      args: CHROME_ARGS,
    });

    const result = await scraper.triggerTwoFactorAuth(parsed.data.phone_number);
    if (!result?.success) {
      return res.status(502).json({ error: 'otp_trigger_failed' });
    }

    const sessionId = crypto.randomBytes(24).toString('hex');
    otpSessions.set(sessionId, { scraper, expiresAt: Date.now() + OTP_SESSION_TTL_MS });

    return res.json({
      success: true,
      session_id: sessionId,
      expires_in_seconds: OTP_SESSION_TTL_MS / 1000,
    });
  } catch (err) {
    console.error(`ONE ZERO OTP start error: ${otpErrorText(err)}`);
    return res.status(500).json({ error: 'otp_trigger_failed' });
  }
});

app.post('/otp/one-zero/verify', requireApiKey, async (req, res) => {
  const parsed = otpVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_otp_request' });
  }

  purgeExpiredOtpSessions();
  const session = otpSessions.get(parsed.data.session_id);
  if (!session) {
    return res.status(410).json({ error: 'otp_session_expired' });
  }

  try {
    const result = await session.scraper.getLongTermTwoFactorToken(parsed.data.otp_code);
    if (!result?.success || !result.longTermTwoFactorAuthToken) {
      return res.status(401).json({ error: 'otp_verification_failed' });
    }

    // One-time handoff to the trusted Edge Function, then drop the session.
    otpSessions.delete(parsed.data.session_id);
    return res.json({ success: true, otp_long_term_token: result.longTermTwoFactorAuthToken });
  } catch (err) {
    otpSessions.delete(parsed.data.session_id);
    console.error(`ONE ZERO OTP verify error: ${otpErrorText(err)}`);
    return res.status(500).json({ error: 'otp_verification_failed' });
  }
});


app.post('/scrape', requireApiKey, async (req, res) => {
  const parsed = scrapeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    // Do not echo `details` — the failing payload contains credentials.
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { credentials, start_date } = parsed.data;
  const bankType = normalizeBankType(parsed.data.bank_type);
  const secretValues = Object.values(credentials);

  if (!SUPPORTED_COMPANIES.has(bankType)) {
    return res.status(400).json({ error: `Unsupported bank_type: ${bankType}` });
  }

  const credSchema = credentialsSchemas[bankType];
  if (!credSchema) {
    return res.status(400).json({ error: `No credentials schema for ${bankType}` });
  }
  const credParsed = credSchema.safeParse(credentials);
  if (!credParsed.success) {
    // Report only which fields are wrong, never their values.
    return res.status(400).json({
      error: 'Invalid credentials shape',
      fields: Object.keys(credParsed.error.flatten().fieldErrors),
    });
  }

  const startDate = start_date
    ? new Date(start_date)
    : new Date(Date.now() - DEFAULT_START_DAYS * 24 * 60 * 60 * 1000);

  const options = {
    companyId: bankType,
    startDate,
    combineInstallments: false,
    showBrowser: false,
    verbose: false,
    timeout: 120_000,
    args: CHROME_ARGS,
    preparePage: prepareBankPage,
  };

  try {
    const scraper = createScraper(options);
    if (bankType === CompanyTypes.beinleumi) {
      applyFibiEmbeddedLogin(scraper);
    }
    const result = await scraper.scrape(credParsed.data);

    if (!result.success) {
      return res.status(502).json({
        error: result.errorType || 'scrape_failed',
        message: sanitizeMessage(result.errorMessage || 'Unknown scraping error', secretValues),
      });
    }

    // Flatten accounts -> transactions, attach account number
    const transactions = [];
    let totalBalance = 0;
    let hasBalance = false;

    for (const account of result.accounts || []) {
      if (typeof account.balance === 'number') {
        totalBalance += account.balance;
        hasBalance = true;
      }
      for (const txn of account.txns || []) {
        transactions.push({
          account_number: account.accountNumber,
          identifier: txn.identifier != null ? String(txn.identifier) : undefined,
          date: txn.date,
          processed_date: txn.processedDate,
          original_amount: txn.originalAmount,
          original_currency: txn.originalCurrency,
          charged_amount: txn.chargedAmount,
          charged_currency: txn.chargedCurrency,
          description: txn.description,
          memo: txn.memo,
          status: txn.status,
          type: txn.type,
          category: txn.category,
          installments: txn.installments,
        });
      }
    }

    return res.json({
      success: true,
      balance: hasBalance ? totalBalance : null,
      accounts: (result.accounts || []).map((a) => ({
        account_number: a.accountNumber,
        balance: typeof a.balance === 'number' ? a.balance : null,
        txns_count: (a.txns || []).length,
      })),
      transactions,
    });
  } catch (err) {
    const message = sanitizeMessage(
      err instanceof Error ? err.message : 'Unknown error',
      secretValues
    );
    // Log the sanitized message only — never the error object (it can carry
    // request payloads containing credentials).
    console.error(`Scrape error [${bankType}]: ${message}`);
    return res.status(500).json({ error: 'internal_error', message });
  }
});

app.listen(PORT, () => {
  console.log(`Scraper server listening on port ${PORT}`);
});
