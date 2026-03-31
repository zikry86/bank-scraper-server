require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { createScraper } = require('israeli-bank-scrapers');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.error('ERROR: API_KEY environment variable is required');
  process.exit(1);
}

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// API Key authentication middleware
function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Map bank types to scraper company IDs
const BANK_TYPE_MAP = {
  hapoalim: 'hapoalim',
  leumi: 'leumi',
  discount: 'discount',
  mizrahi: 'mizrahi',
  mercantile: 'mercantile',
  otsarHahayal: 'otsarHahayal',
  hapoalimBeOnline: 'hapoalimBeOnline',
  massad: 'massad',
  yahav: 'yahav',
  jerusalem: 'jerusalem',
  // Credit cards
  cal: 'visaCal',
  max: 'max',
  isracard: 'isracard',
  amex: 'amex',
  beyondBenleumi: 'beyondBenleumi',
};

// Scrape endpoint
app.post('/scrape', authenticate, async (req, res) => {
  const { bank_type, credentials, connection_id, organization_id } = req.body;

  if (!bank_type || !credentials) {
    return res.status(400).json({ error: 'Missing bank_type or credentials' });
  }

  const companyId = BANK_TYPE_MAP[bank_type];
  if (!companyId) {
    return res.status(400).json({ error: `Unsupported bank type: ${bank_type}` });
  }

  console.log(`[${new Date().toISOString()}] Scraping ${bank_type} for connection ${connection_id}`);

  try {
    const options = {
      companyId,
      startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // Last 90 days
      combineInstallments: false,
      showBrowser: false, // Headless mode
    };

    const scraper = createScraper(options);
    const scrapeResult = await scraper.scrape(credentials);

    if (!scrapeResult.success) {
      console.error(`Scrape failed for ${bank_type}:`, scrapeResult.errorType, scrapeResult.errorMessage);
      return res.status(422).json({
        error: 'Scrape failed',
        errorType: scrapeResult.errorType,
        errorMessage: scrapeResult.errorMessage,
      });
    }

    // Flatten transactions from all accounts
    const transactions = [];
    let balance = undefined;

    for (const account of scrapeResult.accounts || []) {
      if (account.balance !== undefined && account.balance !== null) {
        balance = (balance || 0) + account.balance;
      }

      for (const txn of account.txns || []) {
        transactions.push({
          date: txn.date,
          description: txn.description,
          originalAmount: txn.originalAmount,
          chargedAmount: txn.chargedAmount,
          originalCurrency: txn.originalCurrency,
          memo: txn.memo || null,
          category: txn.category || null,
          type: txn.type, // 'normal' | 'installments'
          status: txn.status, // 'completed' | 'pending'
          identifier: txn.identifier || null,
        });
      }
    }

    console.log(`[${new Date().toISOString()}] Success: ${transactions.length} transactions, balance: ${balance}`);

    res.json({
      success: true,
      transactions,
      balance,
      accounts_count: scrapeResult.accounts?.length || 0,
    });
  } catch (error) {
    console.error(`Scrape error for ${bank_type}:`, error);
    res.status(500).json({
      error: 'Internal scraper error',
      message: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Scraper server running on port ${PORT}`);
});
