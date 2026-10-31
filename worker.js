const ALLOWED_ORIGINS = new Set([
  'https://www.oaxo.com.br',
  'https://oaxo.com.br',
  'https://equilbrioappbr.github.io',
  'http://localhost:8787'
]);
const SYMBOL_RE = /^[A-Z0-9.]{3,12}$/;
const DEFAULT_SYMBOLS = ['PETR4','VALE3','ITUB4','BBAS3','BBDC4','WEGE3','BOVA11'];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : 'https://www.oaxo.com.br';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Vary': 'Origin'
  };
}
function json(data, status, origin, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin), ...extra }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== 'GET') return json({ error: 'Método não permitido.' }, 405, origin);
    if (url.pathname !== '/quotes') return json({ error: 'Rota não encontrada.' }, 404, origin);
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: 'Origem não autorizada.' }, 403, origin);
    if (!env.BRAPI_TOKEN) return json({ error: 'A chave BRAPI_TOKEN ainda não foi configurada no Worker.' }, 503, origin);

    const raw = (url.searchParams.get('symbols') || DEFAULT_SYMBOLS.join(',')).toUpperCase();
    const symbols = [...new Set(raw.split(',').map(s => s.trim()).filter(s => SYMBOL_RE.test(s)))].slice(0, 20);
    if (!symbols.length) return json({ error: 'Informe ao menos um código de ativo válido.' }, 400, origin);

    // Cache público apenas de cotações; nenhuma informação pessoal ou da carteira passa por este Worker.
    const cacheUrl = new URL(request.url);
    cacheUrl.searchParams.set('symbols', symbols.join(','));
    const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) {
      const headers = new Headers(cached.headers);
      Object.entries(corsHeaders(origin)).forEach(([k,v]) => headers.set(k,v));
      headers.set('X-OAXO-Cache', 'HIT');
      return new Response(cached.body, { status: cached.status, headers });
    }

    try {
      const upstreamUrl = new URL('https://brapi.dev/api/quote/' + encodeURIComponent(symbols.join(',')));
      upstreamUrl.searchParams.set('token', env.BRAPI_TOKEN);
      upstreamUrl.searchParams.set('range', '1d');
      upstreamUrl.searchParams.set('interval', '1d');
      const upstream = await fetch(upstreamUrl.toString(), {
        headers: { 'Accept': 'application/json', 'User-Agent': 'OAXO-MARKET/1.0' }
      });
      const payload = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        const message = payload?.message || payload?.error || 'O provedor recusou a consulta.';
        return json({ error: String(message).slice(0, 220), providerStatus: upstream.status }, 502, origin, { 'Cache-Control': 'no-store' });
      }
      const results = Array.isArray(payload?.results) ? payload.results : [];
      const safeResults = results.map(q => ({
        symbol: String(q.symbol || '').toUpperCase(),
        shortName: q.shortName || q.longName || q.symbol || '',
        longName: q.longName || '',
        currency: q.currency || 'BRL',
        regularMarketPrice: Number.isFinite(Number(q.regularMarketPrice)) ? Number(q.regularMarketPrice) : null,
        regularMarketChangePercent: Number.isFinite(Number(q.regularMarketChangePercent)) ? Number(q.regularMarketChangePercent) : null,
        regularMarketTime: q.regularMarketTime || q.regularMarketTimeFormatted || null,
        marketState: q.marketState || null
      }));
      const result = {
        source: 'brapi',
        delayed: true,
        updatedAt: new Date().toISOString(),
        providerUpdatedAt: payload?.results?.[0]?.regularMarketTime || null,
        results: safeResults
      };
      const response = json(result, 200, origin, {
        'Cache-Control': 'public, max-age=0, s-maxage=900',
        'X-OAXO-Cache': 'MISS'
      });
      // Cache API honors Cache-Control on Cloudflare; TTL 15 minutes to limit free-tier API use.
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      return json({ error: 'Não foi possível consultar a fonte de mercado. Tente novamente mais tarde.' }, 502, origin, { 'Cache-Control': 'no-store' });
    }
  }
};
