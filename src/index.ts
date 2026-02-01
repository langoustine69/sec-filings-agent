import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';

const USER_AGENT = 'Langoustine69-SEC-Agent/1.0 (goust@langoustine69.dev)';
const SEC_BASE = 'https://data.sec.gov';

const agent = await createAgent({
  name: 'sec-filings-agent',
  version: '1.0.0',
  description: 'SEC EDGAR company filings - lookup by ticker, get 10-K/10-Q/8-K filings, insider trades. Real-time government data for financial agents.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// Cache for ticker->CIK mapping
let tickerCache: Record<string, { cik: string; title: string }> = {};
let cacheTime = 0;

async function loadTickerCache(): Promise<void> {
  const now = Date.now();
  if (Object.keys(tickerCache).length > 0 && now - cacheTime < 3600000) return;
  
  const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': USER_AGENT }
  });
  if (!res.ok) throw new Error(`Failed to load tickers: ${res.status}`);
  
  const data = await res.json() as Record<string, { cik_str: string; ticker: string; title: string }>;
  tickerCache = {};
  for (const entry of Object.values(data)) {
    tickerCache[entry.ticker.toUpperCase()] = {
      cik: entry.cik_str.toString().padStart(10, '0'),
      title: entry.title
    };
  }
  cacheTime = now;
}

function getCikFromTicker(ticker: string): string | null {
  const entry = tickerCache[ticker.toUpperCase()];
  return entry ? entry.cik : null;
}

async function fetchCompanySubmissions(cik: string) {
  const res = await fetch(`${SEC_BASE}/submissions/CIK${cik}.json`, {
    headers: { 'User-Agent': USER_AGENT }
  });
  if (!res.ok) throw new Error(`SEC API error: ${res.status}`);
  return res.json();
}

// === FREE ENDPOINT ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview - try before you buy. Returns basic info about a company by ticker.',
  input: z.object({
    ticker: z.string().optional().default('AAPL').describe('Stock ticker symbol')
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    await loadTickerCache();
    const ticker = ctx.input.ticker.toUpperCase();
    const cik = getCikFromTicker(ticker);
    
    if (!cik) {
      return { output: { error: `Ticker ${ticker} not found`, availableTickers: Object.keys(tickerCache).slice(0, 20) } };
    }
    
    const data = await fetchCompanySubmissions(cik) as any;
    return {
      output: {
        ticker,
        name: data.name,
        cik: data.cik,
        sic: data.sic,
        sicDescription: data.sicDescription,
        recentFilingsCount: data.filings?.recent?.form?.length || 0,
        fetchedAt: new Date().toISOString(),
        dataSource: 'SEC EDGAR (live)'
      }
    };
  },
});

// === PAID ENDPOINT 1 ($0.001) - Full company profile ===
addEntrypoint({
  key: 'company',
  description: 'Full company profile by ticker - includes business info, fiscal year, entity type, addresses',
  input: z.object({
    ticker: z.string().describe('Stock ticker symbol (e.g., AAPL, MSFT, NVDA)')
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    await loadTickerCache();
    const ticker = ctx.input.ticker.toUpperCase();
    const cik = getCikFromTicker(ticker);
    
    if (!cik) {
      return { output: { error: `Ticker ${ticker} not found` } };
    }
    
    const data = await fetchCompanySubmissions(cik) as any;
    return {
      output: {
        ticker,
        name: data.name,
        cik: data.cik,
        ein: data.ein,
        sic: data.sic,
        sicDescription: data.sicDescription,
        category: data.category,
        entityType: data.entityType,
        fiscalYearEnd: data.fiscalYearEnd,
        stateOfIncorporation: data.stateOfIncorporation,
        phone: data.phone,
        addresses: data.addresses,
        website: data.website,
        formerNames: data.formerNames,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 2 ($0.002) - Recent filings with filters ===
addEntrypoint({
  key: 'filings',
  description: 'Recent SEC filings by ticker with optional form type filter (10-K, 10-Q, 8-K, etc.)',
  input: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
    formType: z.string().optional().describe('Filter by form type: 10-K, 10-Q, 8-K, 4, DEF 14A, etc.'),
    limit: z.number().optional().default(20).describe('Max filings to return (1-100)')
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    await loadTickerCache();
    const ticker = ctx.input.ticker.toUpperCase();
    const cik = getCikFromTicker(ticker);
    
    if (!cik) {
      return { output: { error: `Ticker ${ticker} not found` } };
    }
    
    const data = await fetchCompanySubmissions(cik) as any;
    const recent = data.filings?.recent;
    if (!recent) {
      return { output: { error: 'No filings found' } };
    }
    
    const limit = Math.min(ctx.input.limit, 100);
    const filings: any[] = [];
    
    for (let i = 0; i < recent.form.length && filings.length < limit; i++) {
      if (ctx.input.formType && recent.form[i] !== ctx.input.formType.toUpperCase()) {
        continue;
      }
      filings.push({
        form: recent.form[i],
        filingDate: recent.filingDate[i],
        accessionNumber: recent.accessionNumber[i],
        primaryDocument: recent.primaryDocument[i],
        description: recent.primaryDocDescription?.[i] || null,
        documentUrl: `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, '')}/${recent.accessionNumber[i].replace(/-/g, '')}/${recent.primaryDocument[i]}`
      });
    }
    
    return {
      output: {
        ticker,
        companyName: data.name,
        totalFilings: recent.form.length,
        filteredCount: filings.length,
        filings,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 3 ($0.002) - Search tickers by name ===
addEntrypoint({
  key: 'search',
  description: 'Search company tickers by name',
  input: z.object({
    query: z.string().describe('Company name to search for'),
    limit: z.number().optional().default(10).describe('Max results (1-50)')
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    await loadTickerCache();
    const query = ctx.input.query.toLowerCase();
    const limit = Math.min(ctx.input.limit, 50);
    
    const results: { ticker: string; name: string; cik: string }[] = [];
    
    for (const [ticker, entry] of Object.entries(tickerCache)) {
      if (entry.title.toLowerCase().includes(query) || ticker.toLowerCase().includes(query)) {
        results.push({
          ticker,
          name: entry.title,
          cik: entry.cik
        });
        if (results.length >= limit) break;
      }
    }
    
    return {
      output: {
        query: ctx.input.query,
        resultCount: results.length,
        results,
        totalCompanies: Object.keys(tickerCache).length,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 4 ($0.003) - Insider trades (Form 4) ===
addEntrypoint({
  key: 'insider-trades',
  description: 'Recent insider trading activity (Form 4 filings) for a company',
  input: z.object({
    ticker: z.string().describe('Stock ticker symbol'),
    limit: z.number().optional().default(10).describe('Max Form 4 filings (1-50)')
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    await loadTickerCache();
    const ticker = ctx.input.ticker.toUpperCase();
    const cik = getCikFromTicker(ticker);
    
    if (!cik) {
      return { output: { error: `Ticker ${ticker} not found` } };
    }
    
    const data = await fetchCompanySubmissions(cik) as any;
    const recent = data.filings?.recent;
    if (!recent) {
      return { output: { error: 'No filings found' } };
    }
    
    const limit = Math.min(ctx.input.limit, 50);
    const trades: any[] = [];
    
    for (let i = 0; i < recent.form.length && trades.length < limit; i++) {
      if (recent.form[i] === '4' || recent.form[i] === '3' || recent.form[i] === '5') {
        trades.push({
          form: recent.form[i],
          filingDate: recent.filingDate[i],
          accessionNumber: recent.accessionNumber[i],
          reportOwner: recent.reportDate?.[i] || null,
          documentUrl: `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, '')}/${recent.accessionNumber[i].replace(/-/g, '')}/${recent.primaryDocument[i]}`
        });
      }
    }
    
    return {
      output: {
        ticker,
        companyName: data.name,
        insiderFilingsCount: trades.length,
        trades,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 5 ($0.005) - Full company report ===
addEntrypoint({
  key: 'report',
  description: 'Comprehensive company report - profile, recent filings by type, and insider activity',
  input: z.object({
    ticker: z.string().describe('Stock ticker symbol')
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    await loadTickerCache();
    const ticker = ctx.input.ticker.toUpperCase();
    const cik = getCikFromTicker(ticker);
    
    if (!cik) {
      return { output: { error: `Ticker ${ticker} not found` } };
    }
    
    const data = await fetchCompanySubmissions(cik) as any;
    const recent = data.filings?.recent;
    
    // Group filings by type
    const filingsByType: Record<string, number> = {};
    const recentByType: Record<string, any[]> = {};
    
    if (recent) {
      for (let i = 0; i < recent.form.length; i++) {
        const form = recent.form[i];
        filingsByType[form] = (filingsByType[form] || 0) + 1;
        
        if (!recentByType[form]) recentByType[form] = [];
        if (recentByType[form].length < 3) {
          recentByType[form].push({
            date: recent.filingDate[i],
            accessionNumber: recent.accessionNumber[i],
            document: recent.primaryDocument[i]
          });
        }
      }
    }
    
    return {
      output: {
        profile: {
          ticker,
          name: data.name,
          cik: data.cik,
          sic: data.sic,
          sicDescription: data.sicDescription,
          category: data.category,
          entityType: data.entityType,
          fiscalYearEnd: data.fiscalYearEnd,
          stateOfIncorporation: data.stateOfIncorporation
        },
        filingsSummary: {
          totalFilings: recent?.form?.length || 0,
          byType: filingsByType
        },
        recentByType,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === ANALYTICS ENDPOINTS ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms')
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available', payments: [] } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return {
      output: {
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      }
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50)
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { transactions: [] } };
    }
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

addEntrypoint({
  key: 'analytics-csv',
  description: 'Export payment data as CSV',
  input: z.object({ windowMs: z.number().optional() }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { csv: '' } };
    }
    const csv = await exportToCSV(tracker, ctx.input.windowMs);
    return { output: { csv } };
  },
});

// Serve icon
app.get('/icon.png', async (c) => {
  try {
    const icon = await Bun.file('./icon.png').arrayBuffer();
    return new Response(icon, { headers: { 'Content-Type': 'image/png' } });
  } catch {
    return c.text('Icon not found', 404);
  }
});

// ERC-8004 registration
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.PUBLIC_URL || 'https://sec-filings-agent-production.up.railway.app';
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "sec-filings-agent",
    description: "SEC EDGAR company filings - lookup by ticker, get 10-K/10-Q/8-K filings, insider trades. Pricing: overview FREE, company $0.001, filings $0.002, search $0.002, insider-trades $0.003, report $0.005",
    image: `${baseUrl}/icon.png`,
    services: [
      { name: "web", endpoint: baseUrl },
      { name: "A2A", endpoint: `${baseUrl}/.well-known/agent.json`, version: "0.3.0" }
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ["reputation"]
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`SEC Filings Agent running on port ${port}`);

export default { port, fetch: app.fetch };
