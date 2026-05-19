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

async function yFetch(url) {
    const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' }
    });
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

        // ---- Quote Summary (BPA / EPS détaillé, cache 10 min) ----
        if (p.startsWith('/api/summary/')) {
            const ticker = decodeURIComponent(p.replace('/api/summary/', ''));
            const key = `summary:${ticker}`;
            const hit = getCached(key, 10 * 60 * 1000);
            if (hit) return json(res, hit);
            const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=defaultKeyStatistics,financialData`;
            const data = await yFetch(url);
            setCache(key, data);
            return json(res, data);
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
