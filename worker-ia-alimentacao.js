/**
 * Cloudflare Worker para análise de fotos de refeições do Equilíbrio.
 * Configure OPENAI_API_KEY como Secret no painel do Cloudflare.
 * A chave nunca deve ser colocada no index.html.
 */
const corsHeaders = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Vary': 'Origin'
};
function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGIN || '').trim();
  // Configure ALLOWED_ORIGIN com a URL publicada do app, ex.: https://equilbrioappbr.github.io
  const originAllowed = !allowed || origin === allowed;
  return { ...corsHeaders, 'Access-Control-Allow-Origin': originAllowed && origin ? origin : allowed || 'null' };
}
function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return json({ error: 'Use POST para enviar uma imagem.' }, 405, headers);
    if (env.ALLOWED_ORIGIN && origin !== env.ALLOWED_ORIGIN) return json({ error: 'Origem não autorizada.' }, 403, headers);
    if (!env.OPENAI_API_KEY) return json({ error: 'O serviço ainda não foi configurado com a chave de IA.' }, 503, headers);
    try {
      const body = await request.json();
      const imageBase64 = String(body.imageBase64 || '');
      const mimeType = String(body.mimeType || 'image/jpeg');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return json({ error: 'Formato de imagem não suportado.' }, 400, headers);
      if (!imageBase64 || imageBase64.length > 5_600_000) return json({ error: 'Imagem ausente ou muito grande. Envie uma foto menor que 4 MB.' }, 413, headers);
      const prompt = `Você é um assistente de registro alimentar. Analise a foto de uma refeição e identifique somente alimentos que sejam razoavelmente visíveis. Responda em português do Brasil. Estime a porção com cautela; não afirme certeza quando a imagem não permitir. Não dê diagnóstico nem recomendação médica. Para cada item, retorne nome, gramas estimados, calorias por 100 g, proteína, carboidratos e gordura por 100 g, fibra em g/100 g e sódio em mg/100 g. Nutrientes devem ser estimativas genéricas coerentes com alimento comum, não valores exatos da foto; se não puder estimar, use null. Não invente itens escondidos. Inclua uma nota curta quando a porção ou identidade for incerta. Use confidence como 'Baixa', 'Média' ou 'Alta', considerando a identificação visual, não a precisão nutricional. Retorne JSON no formato: {"confidence":"Média","foods":[{"name":"arroz cozido","grams":120,"kcalPer100g":130,"proteinPer100g":2.7,"carbsPer100g":28,"fatPer100g":0.3,"fiberPer100g":0.4,"sodiumMgPer100g":1,"notes":"Porção aproximada"}]}. Se não houver comida identificável, retorne foods vazio.`;
      const apiResponse = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: env.OPENAI_MODEL || 'gpt-4.1-mini',
          input: [{ role: 'user', content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: `data:${mimeType};base64,${imageBase64}`, detail: 'low' }
          ] }],
          text: { format: { type: 'json_object' } },
          max_output_tokens: 1200
        })
      });
      const payload = await apiResponse.json().catch(() => ({}));
      if (!apiResponse.ok) return json({ error: 'A análise por IA falhou. Verifique a configuração e o limite da conta.' }, 502, headers);
      let outputText = payload.output_text;
      if (!outputText && Array.isArray(payload.output)) {
        outputText = payload.output.flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n');
      }
      if (!outputText) return json({ error: 'A IA não retornou uma análise válida.' }, 502, headers);
      const parsed = JSON.parse(outputText);
      const foods = Array.isArray(parsed.foods) ? parsed.foods.slice(0, 12).map(f => ({
        name: String(f.name || 'Alimento não identificado').slice(0, 100),
        grams: clampNum(f.grams, 1, 2000, 100),
        kcalPer100g: nullableNum(f.kcalPer100g, 0, 900),
        proteinPer100g: nullableNum(f.proteinPer100g, 0, 100),
        carbsPer100g: nullableNum(f.carbsPer100g, 0, 100),
        fatPer100g: nullableNum(f.fatPer100g, 0, 100),
        fiberPer100g: nullableNum(f.fiberPer100g, 0, 100),
        sodiumMgPer100g: nullableNum(f.sodiumMgPer100g, 0, 100000),
        notes: String(f.notes || '').slice(0, 160)
      })) : [];
      return json({ confidence: ['Baixa', 'Média', 'Alta'].includes(parsed.confidence) ? parsed.confidence : 'Estimativa — confira antes de confiar', foods }, 200, headers);
    } catch (err) {
      return json({ error: 'Não foi possível processar a imagem. Tente novamente ou registre manualmente.' }, 400, headers);
    }
  }
};
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function nullableNum(v, min, max) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
}
