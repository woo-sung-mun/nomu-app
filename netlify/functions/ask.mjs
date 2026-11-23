// 사장님 노무비서 · AI 연결 함수 (Netlify Functions)
// API 키는 Netlify 환경변수 GEMINI_API_KEY 에만 저장되고 화면에는 드러나지 않습니다.


const BASE = `너는 한국의 자영업자(직원 1~10명 규모 가게 사장님)를 돕는 노무 상담 비서 "노무비서"다.
- 2026년 기준 한국 근로기준법, 최저임금법, 근로자퇴직급여 보장법을 바탕으로 답한다. 2026년 최저임금은 시급 10,320원이다.
- 5인 미만 사업장은 연차휴가, 연장·야간·휴일 가산수당, 공휴일 유급휴일, 부당해고 구제, 해고 서면통지가 적용되지 않는다. 주휴수당, 최저임금, 퇴직금, 휴게시간, 해고예고, 근로계약서 서면 교부, 임금명세서, 4대보험은 규모와 상관없이 적용된다.
- 사장님이 바로 이해하도록 쉬운 말과 존댓말로, 법조문 번호 나열은 피한다.
- 확실하지 않거나 사안별 판단이 필요한 부분은 그렇다고 말하고 공인노무사나 고용노동부(1350) 상담을 권한다.
- 노무와 관계없는 요청에는 정중히 노무 질문만 도와드린다고 답한다.
- 마크다운은 **굵게**, "- " 목록, "### 소제목"만 쓴다. 표는 쓰지 않는다.`;

const SIZE_TEXT = { under5: '상시 근로자 5인 미만 사업장', over5: '상시 근로자 5인 이상 사업장' };

function buildPrompt(body) {
  const sizeLine = `이 사장님의 가게는 ${SIZE_TEXT[body.size] || SIZE_TEXT.under5}이다. 반드시 이 규모 기준으로 답한다.`;
  if (body.mode === 'chat') {
    const q = String(body.question || '').slice(0, 800).trim();
    if (!q) return null;
    const hist = Array.isArray(body.history) ? body.history.slice(-6) : [];
    const contents = hist
      .filter(h => h && (h.role === 'user' || h.role === 'model') && typeof h.text === 'string')
      .map(h => ({ role: h.role, parts: [{ text: h.text.slice(0, 2000) }] }));
    contents.push({ role: 'user', parts: [{ text: q }] });
    return {
      system: `${BASE}\n${sizeLine}\n답변 형식: 첫 줄에 **결론:** 한 문장, 이어서 "### 이유" 2~3줄, "### 사장님이 할 일" 목록 2~4개. 전체 250자~500자 정도로 짧게.`,
      contents
    };
  }
  if (body.mode === 'checklist') {
    const items = Array.isArray(body.items) ? body.items.slice(0, 20) : [];
    const lines = items.map((it, i) => `${i + 1}. ${String(it.item).slice(0, 100)} → ${String(it.answer).slice(0, 10)}`).join('\n');
    return {
      system: `${BASE}\n${sizeLine}`,
      contents: [{ role: 'user', parts: [{ text: `우리 가게 노무 점검표 결과입니다.\n${lines}\n\n"아니오"와 "모름" 항목을 위험이 큰 순서로 골라, "### 한 줄 진단" 한 문장, "### 이번 주에 할 일" 우선순위 목록 최대 3개(각각 무엇을 어떻게 하면 되는지 구체적으로), "### 알아두면 좋은 지원제도" 1~2개(예: 두루누리 사회보험료 지원)를 알려 주세요. 모두 "예"라면 칭찬과 함께 유지 관리 팁 3가지를 주세요. 400~700자.` }] }]
    };
  }
  if (body.mode === 'contract') {
    const c = body.contract && typeof body.contract === 'object' ? body.contract : {};
    const text = Object.entries(c).slice(0, 15).map(([k, v]) => `- ${String(k).slice(0, 20)}: ${String(v).slice(0, 200)}`).join('\n');
    return {
      system: `${BASE}\n${sizeLine}`,
      contents: [{ role: 'user', parts: [{ text: `아래 조건으로 근로계약서를 쓰려고 합니다.\n${text}\n\n"### 검토 결과" 법 위반이나 빠진 부분이 있는지 목록으로(없으면 없다고), "### 이 직원에게 적용되는 것" 주휴수당·4대보험·퇴직금·연차 해당 여부를 한 줄씩, "### 넣으면 좋은 약정 문구" 분쟁 예방에 도움이 되는 문구 2개를 계약서에 바로 쓸 수 있는 문장으로 주세요. 400~700자.` }] }]
    };
  }
  return null;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});

const getEnv = k => (globalThis.Netlify?.env?.get?.(k)) || process.env[k] || '';
// 빠른 모델부터 시도합니다(Netlify 무료 함수는 10초 안에 끝나야 함).
// 구글이 "이 모델 대신 models/○○ 을 쓰라"고 알려 주면 그 모델을 바로 다음에 시도합니다.
const MODELS = () => [...new Set([getEnv('GEMINI_MODEL'), 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-flash-lite-latest', 'gemini-flash-latest'].filter(Boolean))];
const AUTHS = ['header', 'query', 'bearer'];
const BUDGET_MS = 9200;

async function callGemini(key, basePayload) {
  const tried = [];
  const deadline = Date.now() + BUDGET_MS;
  const queue = MODELS();
  const seen = new Set();
  let auths = AUTHS;
  while (queue.length) {
    const model = queue.shift();
    if (seen.has(model)) continue;
    seen.add(model);
    let think = model.startsWith('gemini-3');      // 3.x 모델은 생각 단계를 줄여 빠르게
    for (let i = 0; i < auths.length; i++) {
      const auth = auths[i];
      const left = deadline - Date.now();
      if (left < 800) return { ok: false, tried, timeout: true };
      let url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const headers = { 'Content-Type': 'application/json' };
      if (auth === 'header') headers['x-goog-api-key'] = key;
      if (auth === 'query') url += `?key=${encodeURIComponent(key)}`;
      if (auth === 'bearer') headers['Authorization'] = `Bearer ${key}`;
      const payload = JSON.parse(JSON.stringify(basePayload));
      if (think) payload.generationConfig = Object.assign({}, payload.generationConfig, { thinkingConfig: { thinkingLevel: 'low' } });
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(left, 7000)); // 한 모델이 7초 넘게 걸리면 다음 모델로
      let r, data;
      try {
        r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
        data = await r.json().catch(() => ({}));
      } catch (e) {
        tried.push({ model, auth, status: 0, message: ctrl.signal.aborted ? '시간 초과' : String(e).slice(0, 200) });
        break;
      } finally { clearTimeout(timer); }
      if (r.ok) {
        const text = (data.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('').trim();
        if (text) return { ok: true, text, model, auth, tried };
        tried.push({ model, auth, status: 200, message: '빈 응답' });
        break;
      }
      const msg = String(data?.error?.message || '');
      tried.push({ model, auth, status: r.status, message: msg.slice(0, 300) });
      if (r.status === 400 && think && /think/i.test(msg)) { think = false; i--; continue; } // 생각 설정 미지원 → 설정 빼고 재시도
      if (r.status === 404) {
        const sug = [...msg.matchAll(/models\/(gemini-[a-z0-9.\-]*[a-z0-9])/gi)].map(x => x[1]);
        sug.filter(m => m !== model).reverse().forEach(m => queue.unshift(m));
      }
      if (![400, 401, 403].includes(r.status)) { auths = [auth]; break; } // 인증은 통과 → 이 방식 고정, 다음 모델로
    }
  }
  return { ok: false, tried };
}

export default async (req) => {
  const key = getEnv('GEMINI_API_KEY').trim();

  // 진단: 브라우저에서 /api/ask 를 열면 연결 상태를 보여 줍니다(키 값은 보여 주지 않음).
  if (req.method === 'GET') {
    if (!key) return json({ keySet: false, hint: 'Netlify에 GEMINI_API_KEY 가 등록되지 않았거나 함수에서 읽을 수 없습니다.' });
    const res = await callGemini(key, { contents: [{ role: 'user', parts: [{ text: '안녕하세요라고만 답해 주세요.' }] }] });
    return json({ keySet: true, keyStart: key.slice(0, 3), keyLength: key.length, ok: res.ok, model: res.model, auth: res.auth, reply: res.text, tried: res.tried });
  }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!key) return json({ error: 'GEMINI_API_KEY 환경변수가 설정되지 않았습니다.' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: '잘못된 요청입니다.' }, 400); }
  const p = buildPrompt(body || {});
  if (!p) return json({ error: '지원하지 않는 요청입니다.' }, 400);

  const res = await callGemini(key, {
    systemInstruction: { parts: [{ text: p.system }] },
    contents: p.contents,
    generationConfig: { temperature: 0.3, maxOutputTokens: 1500 }
  });
  if (!res.ok || !res.text) {
    console.error('Gemini failed', JSON.stringify(res.tried));
    return json({ error: 'AI 응답 오류', tried: res.tried }, 502);
  }
  return json({ text: res.text });
};

export const config = { path: '/api/ask' };
