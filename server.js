const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const cache = new Map();

function getCached(key, ttlMs) {
    const e = cache.get(key);
    return (e && Date.now() - e.ts < ttlMs) ? e.data : null;
}
function setCache(key, data) {
    cache.set(key, { data, ts: Date.now() });
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function yFetch(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}


function json(res, data, status = 200) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript',
    '.css':  'text/css',
    '.ico':  'image/x-icon',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
};

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve({}); } });
        req.on('error', reject);
    });
}

http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://localhost:${PORT}`);
    const p = parsed.pathname;

    try {
        // ---- Taux de change USD/EUR (cache 1h) ----
        if (p === '/api/rate') {
            const hit = getCached('rate', 60 * 60 * 1000);
            if (hit) return json(res, hit);
            const data = await yFetch('https://open.er-api.com/v6/latest/USD');
            setCache('rate', data);
            return json(res, data);
        }

        // ---- Cours batch (cache 1 min) ----
        if (p === '/api/quote') {
            const symbols = parsed.searchParams.get('symbols') || '';
            const key = `quote:${symbols}`;
            const hit = getCached(key, 60 * 1000);
            if (hit) return json(res, hit);
            const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=marketCap,sharesOutstanding,trailingPE,forwardPE,epsTrailingTwelveMonths,regularMarketPrice,currency,shortName,longName,exchange,exchangeName`;
            const data = await yFetch(url);
            setCache(key, data);
            return json(res, data);
        }

        // ---- Cours batch via TradingView screener (cache 1 min) ----
        if (p === '/api/tv-prices') {
            const symbols = (parsed.searchParams.get('symbols') || '').split(',').filter(Boolean);
            const key = `tv-prices:${symbols.join(',')}`;
            const hit = getCached(key, 60 * 1000);
            if (hit) return json(res, hit);

            const tvMap = {
                '.PA': ['france',      s => `EURONEXT:${s}`],
                '.DE': ['germany',     s => `XETR:${s}`],
                '.L':  ['uk',          s => `LSE:${s}`],
                '.MI': ['italy',       s => `MIL:${s}`],
                '.AS': ['netherlands', s => `EURONEXT:${s}`],
                '.BR': ['belgium',     s => `EURONEXT:${s}`],
                '.MC': ['spain',       s => `BME:${s}`],
            };

            const byMarket = {};
            const symbolMap = {};
            for (const ticker of symbols) {
                const ext = Object.keys(tvMap).find(k => ticker.endsWith(k));
                const market = ext ? tvMap[ext][0] : 'america';
                const tvSym  = ext ? tvMap[ext][1](ticker.slice(0, -ext.length)) : ticker;
                if (!byMarket[market]) byMarket[market] = [];
                byMarket[market].push(tvSym);
                symbolMap[tvSym] = ticker;
            }

            const prices = {};
            await Promise.allSettled(Object.entries(byMarket).map(async ([market, tvSymbols]) => {
                try {
                    const r = await fetch(`https://scanner.tradingview.com/${market}/scan`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
                        body: JSON.stringify({ symbols: { tickers: tvSymbols }, columns: ['close', 'currency'] }),
                    });
                    const data = await r.json();
                    (data?.data || []).forEach(item => {
                        // TV peut retourner "NASDAQ:AAPL" ou "AAPL" — on essaie les deux
                        const yahoo = symbolMap[item.s] || symbolMap[item.s?.split(':').pop()];
                        if (yahoo && typeof item.d?.[0] === 'number') prices[yahoo] = { price: item.d[0], currency: item.d[1] || 'EUR' };
                    });
                } catch(e) { console.error('[tv-prices]', market, e.message); }
            }));

            setCache(key, prices);
            return json(res, prices);
        }

        // ---- Endpoint combiné taux + cours (1 seul aller-retour, cache 45s) ----
        if (p === '/api/prices') {
            const symbols = parsed.searchParams.get('symbols') || '';
            const key = `prices:${symbols}`;
            const hit = getCached(key, 45 * 1000);
            if (hit) return json(res, hit);

            const quoteUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=epsTrailingTwelveMonths,regularMarketPrice,currency,shortName,longName,exchange,exchangeName`;
            const [rateRes, quoteRes] = await Promise.allSettled([
                getCached('rate', 60 * 60 * 1000)
                    ? Promise.resolve(getCached('rate', 60 * 60 * 1000))
                    : yFetch('https://open.er-api.com/v6/latest/USD').then(d => { setCache('rate', d); return d; }),
                getCached(`quote:${symbols}`, 60 * 1000)
                    ? Promise.resolve(getCached(`quote:${symbols}`, 60 * 1000))
                    : yFetch(quoteUrl).then(d => { setCache(`quote:${symbols}`, d); return d; }),
            ]);

            const result = {
                rate:  rateRes.status  === 'fulfilled' ? rateRes.value  : null,
                quote: quoteRes.status === 'fulfilled' ? quoteRes.value : null,
            };
            setCache(key, result);
            return json(res, result);
        }

        // ---- Historique graphique (cache 5 min) ----
        if (p.startsWith('/api/chart/')) {
            const ticker = decodeURIComponent(p.replace('/api/chart/', ''));
            const range    = parsed.searchParams.get('range')    || '1y';
            const interval = parsed.searchParams.get('interval') || '1wk';
            const key = `chart:${ticker}:${range}`;
            const hit = getCached(key, 5 * 60 * 1000);
            if (hit) return json(res, hit);
            const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}&events=dividends&includePrePost=false`;
            const data = await yFetch(url);
            setCache(key, data);
            return json(res, data);
        }

        // ---- Recherche action Yahoo (cache 30s) ----
        if (p === '/api/search') {
            const q = parsed.searchParams.get('q') || '';
            const key = `search:${q}`;
            const hit = getCached(key, 30 * 1000);
            if (hit) return json(res, hit);
            const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&lang=fr-FR&quotesCount=8&newsCount=0&enableFuzzyQuery=true`;
            const data = await yFetch(url);
            setCache(key, data);
            return json(res, data);
        }

        // ---- EPS (cache 24h) ----
        if (p.startsWith('/api/eps/')) {
            const ticker = decodeURIComponent(p.replace('/api/eps/', ''));
            const cacheKey = `eps:${ticker}`;
            const hit = getCached(cacheKey, 24 * 60 * 60 * 1000);
            if (hit) return json(res, hit);

            // Tentative 1 : earnings events du chart Yahoo (US stocks)
            try {
                const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=4y&interval=3mo&events=earnings&includePrePost=false`;
                const chartData = await yFetch(chartUrl);
                const events = chartData?.chart?.result?.[0]?.events?.earnings || {};
                const now = Date.now() / 1000;
                const oneYearAgo = now - 365 * 24 * 3600;
                const recent = Object.values(events)
                    .filter(e => e.epsActual != null && e.date <= now && e.date >= oneYearAgo)
                    .sort((a, b) => b.date - a.date);
                const source = recent.length >= 1 ? recent
                    : Object.values(events)
                        .filter(e => e.epsActual != null && e.date <= now)
                        .sort((a, b) => b.date - a.date).slice(0, 4);
                if (source.length > 0) epsFromChart = source.reduce((s, e) => s + e.epsActual, 0);
            } catch(e) { console.error('[eps chart]', e.message); }

            // Tentative 2 : TradingView screener (EU + US — EPS fallback + PER toujours)
            try {
                const tvMap = {
                    '.PA': ['france',      s => `EURONEXT:${s}`],
                    '.DE': ['germany',     s => `XETR:${s}`],
                    '.L':  ['uk',          s => `LSE:${s}`],
                    '.MI': ['italy',       s => `MIL:${s}`],
                    '.AS': ['netherlands', s => `EURONEXT:${s}`],
                    '.BR': ['belgium',     s => `EURONEXT:${s}`],
                    '.MC': ['spain',       s => `BME:${s}`],
                };
                const ext = Object.keys(tvMap).find(k => ticker.endsWith(k));
                const tvMarket = ext ? tvMap[ext][0] : 'america';
                const tvSymbol = ext ? tvMap[ext][1](ticker.slice(0, -ext.length)) : ticker;
                const r = await fetch(`https://scanner.tradingview.com/${tvMarket}/scan`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
                    body: JSON.stringify({ symbols: { tickers: [tvSymbol] }, columns: ['earnings_per_share_basic_ttm', 'price_earnings_ttm'] }),
                });
                const tvData = await r.json();
                const d0 = tvData?.data?.[0]?.d;
                const tvEps = typeof d0?.[0] === 'number' ? d0[0] : null;
                const per   = typeof d0?.[1] === 'number' ? d0[1] : null;
                const eps   = epsFromChart ?? tvEps;
                if (eps !== null || per !== null) {
                    const result = { eps, per, periods: epsFromChart ? 4 : 1 };
                    setCache(cacheKey, result);
                    return json(res, result);
                }
            } catch(e) { console.error('[eps tv]', e.message); }

            if (epsFromChart !== null) {
                const result = { eps: epsFromChart, per: null, periods: 4 };
                setCache(cacheKey, result);
                return json(res, result);
            }

            const empty = { eps: null, per: null, periods: 0 };
            setCache(cacheKey, empty);
            return json(res, empty);
        }

        // ---- Recherche TradingView fallback (cache 30s) ----
        if (p === '/api/tvsearch') {
            const q = parsed.searchParams.get('q') || '';
            const key = `tvsearch:${q}`;
            const hit = getCached(key, 30 * 1000);
            if (hit) return json(res, hit);
            const url = `https://symbol-search.tradingview.com/symbol_search/v3/?text=${encodeURIComponent(q)}&hl=1&exchange=&type=stock,fund,dr&domain=production`;
            const data = await yFetch(url);
            setCache(key, data);
            return json(res, data);
        }

        // ---- Envoi email identifiants via Brevo API (POST) ----
        if (p === '/api/send-email' && req.method === 'POST') {
            const { to, username, password, appUrl } = await parseBody(req);
            if (!to || !username) return json(res, { error: 'Paramètres manquants (to, username)' }, 400);
            if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER) {
                return json(res, { error: 'Variables BREVO_API_KEY / BREVO_SENDER non configurées sur Render' }, 500);
            }
            const htmlBody = `
                <div style="font-family:Inter,sans-serif;max-width:480px;margin:auto;padding:32px;background:#f8fafc;border-radius:12px">
                    <h2 style="color:#1d4ed8;margin-bottom:8px">FinDesk</h2>
                    <p style="color:#374151">Bonjour,</p>
                    <p style="color:#374151">Votre compte FinDesk a été créé. Voici vos identifiants&nbsp;:</p>
                    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin:20px 0">
                        <p style="margin:4px 0;color:#374151"><strong>Identifiant&nbsp;:</strong> ${username}</p>
                        <p style="margin:4px 0;color:#374151"><strong>Mot de passe&nbsp;:</strong> ${password}</p>
                    </div>
                    <a href="${appUrl}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Accéder à FinDesk</a>
                    <p style="color:#9ca3af;font-size:12px;margin-top:24px">Ce message est automatique, ne pas répondre.</p>
                </div>`;
            try {
                const r = await fetch('https://api.brevo.com/v3/smtp/email', {
                    method: 'POST',
                    headers: {
                        'api-key': process.env.BREVO_API_KEY,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        sender: { name: 'FinDesk', email: process.env.BREVO_SENDER },
                        to: [{ email: to }],
                        subject: 'Bienvenue sur FinDesk — Vos identifiants de connexion',
                        htmlContent: htmlBody,
                    }),
                });
                const data = await r.json();
                if (r.ok) return json(res, { ok: true });
                console.error('[email]', data);
                return json(res, { error: data.message || JSON.stringify(data) }, 502);
            } catch (err) {
                console.error('[email]', err.message);
                return json(res, { error: err.message }, 502);
            }
        }

        // ---- Fichiers statiques ----
        let filePath = path.join(__dirname, p === '/' ? 'index.html' : p);
        if (!fs.existsSync(filePath)) filePath = path.join(__dirname, 'index.html');
        const ext  = path.extname(filePath);
        const mime = MIME[ext] || 'text/plain';
        res.writeHead(200, { 'Content-Type': mime });
        fs.createReadStream(filePath).pipe(res);

    } catch (e) {
        console.error(e.message);
        json(res, { error: e.message }, 502);
    }

}).listen(PORT, () => console.log(`FinDesk listening on port ${PORT}`));
