// tc4s-ai-proxy — Cloudflare Worker
//
// Proxies TC4S review AI requests to the Blockbrain Cortex API.
// Auth: caller's GitHub token must have read access to AUTH_REPO.
// Optional: ALLOWED_LOGINS env var for fine-grained pilot whitelist.
//
// Cortex flow per AI call (stateless, one convo per call):
//   1. POST {BLOCKBRAIN_URL}/cortex/active-bot/{BOT_ID}/convo  → convoId
//   2. POST {BLOCKBRAIN_URL}/cortex/completions/v2/user-input → assistant text
//
// Required env vars / secrets (configure in CF dashboard → Variables and Secrets):
//   BLOCKBRAIN_KEY     (Secret) Bearer JWT for Blockbrain
//   BLOCKBRAIN_URL     (Text)   e.g. https://blocky.theblockbrain.ai
//   BLOCKBRAIN_BOT_ID  (Text)   e.g. 6a200fc07a495eca14584185
//   AUTH_REPO          (Text)   e.g. catenax-eV/cx-standard-governance
//   ALLOWED_ORIGIN     (Text)   e.g. https://tc4s-review-assistant.pages.dev
//   ALLOWED_LOGINS     (Text)   optional, comma-separated GitHub handles

const SYSTEM_PROMPT =
  'You are a TC4S (Technical Committee for Standardisation) reviewer for ' +
  'Catena-X standards. Be precise, objective, and concise. Always respond ' +
  'with valid JSON in the exact format requested. Do not add explanations ' +
  'outside the JSON structure.';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': origin === env.ALLOWED_ORIGIN ? origin : '',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-GitHub-Token',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    // Health-check + config visibility (no secret values exposed, just presence)
    const envState = {
      BLOCKBRAIN_KEY: !!env.BLOCKBRAIN_KEY,
      BLOCKBRAIN_URL: !!env.BLOCKBRAIN_URL,
      BLOCKBRAIN_BOT_ID: !!env.BLOCKBRAIN_BOT_ID,
      AUTH_REPO: !!env.AUTH_REPO,
      ALLOWED_ORIGIN: !!env.ALLOWED_ORIGIN,
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET') {
      return json({
        worker: 'tc4s-ai-proxy',
        status: 'alive',
        env_vars_present: envState,
        allowed_origin_value: env.ALLOWED_ORIGIN || null,
        request_origin: origin || null,
        cors_will_allow: origin && origin === env.ALLOWED_ORIGIN,
      }, 200, { 'Content-Type': 'application/json' });
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);

    // Fail fast if Worker is misconfigured
    const missing = Object.entries(envState).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      console.error('Worker missing env vars:', missing.join(','));
      return json({ error: `Worker misconfigured — missing env vars: ${missing.join(', ')}` }, 500, cors);
    }

    // 1. GitHub token from caller
    const ghToken = request.headers.get('X-GitHub-Token');
    if (!ghToken) return json({ error: 'Missing X-GitHub-Token header' }, 401, cors);

    // 2. Verify read access to AUTH_REPO
    const repoCheck = await fetch(`https://api.github.com/repos/${env.AUTH_REPO}`, {
      headers: {
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'tc4s-ai-proxy',
      },
    });
    if (repoCheck.status === 401) return json({ error: 'GitHub token invalid or expired' }, 401, cors);
    if (repoCheck.status !== 200) return json({ error: 'No access to auth repo' }, 403, cors);

    // 3. Optional fine-grained allowlist
    if (env.ALLOWED_LOGINS && env.ALLOWED_LOGINS.trim()) {
      const u = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': `Bearer ${ghToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'tc4s-ai-proxy',
        },
      });
      if (!u.ok) return json({ error: 'Could not resolve GitHub user' }, 401, cors);
      const { login } = await u.json();
      const allow = env.ALLOWED_LOGINS.split(',').map(s => s.trim()).filter(Boolean);
      if (!allow.includes(login)) {
        return json({ error: `User '${login}' not in pilot allowlist` }, 403, cors);
      }
    }

    // 4. Read caller payload
    let payload;
    try { payload = await request.json(); }
    catch { return json({ error: 'Invalid JSON body' }, 400, cors); }
    const { prompt, context } = payload;
    if (!prompt) return json({ error: 'Missing "prompt" field' }, 400, cors);

    const userContent =
      `${SYSTEM_PROMPT}\n\n[Task]\n${prompt}\n\n` +
      `[Content to analyse]\n\`\`\`\n${String(context || '').slice(0, 3000)}\n\`\`\``;

    // 5. Blockbrain Cortex: create convo
    const baseUrl = env.BLOCKBRAIN_URL.replace(/\/$/, '');
    const sessionId = crypto.randomUUID();
    let convoId;
    try {
      const convoResp = await fetch(
        `${baseUrl}/cortex/active-bot/${encodeURIComponent(env.BLOCKBRAIN_BOT_ID)}/convo`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.BLOCKBRAIN_KEY}`,
          },
          body: JSON.stringify({
            convoName: `tc4s-review-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
            sessionId,
          }),
        }
      );
      if (!convoResp.ok) {
        const t = await convoResp.text().catch(() => '');
        console.error('Blockbrain convo failed:', convoResp.status, t.slice(0, 300));
        return json(
          { error: `Blockbrain convo ${convoResp.status}: ${t.slice(0, 200)}` },
          convoResp.status === 401 ? 502 : convoResp.status,
          cors
        );
      }
      const d = await convoResp.json();
      convoId = d.dataRoomId || d.body?.dataRoomId || d.convoId || d.body?.convoId;
      if (!convoId) {
        console.error('Blockbrain convo OK but no id in body:', JSON.stringify(d).slice(0, 300));
        return json(
          { error: `Convo created but no convoId in response: ${JSON.stringify(d).slice(0, 200)}` },
          502,
          cors
        );
      }
      console.log('Blockbrain convo created:', convoId);
    } catch (e) {
      console.error('Convo fetch threw:', e.message);
      return json({ error: `Convo create failed: ${e.message}` }, 502, cors);
    }

    // 6. Blockbrain Cortex: send user input
    let assistantText;
    try {
      const aiResp = await fetch(`${baseUrl}/cortex/completions/v2/user-input`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${env.BLOCKBRAIN_KEY}`,
        },
        body: JSON.stringify({
          content: userContent,
          convoId,
          sessionId,
          actionType: 'user',
          messageType: 'user-question',
        }),
      });
      if (!aiResp.ok) {
        const t = await aiResp.text().catch(() => '');
        console.error('Blockbrain user-input failed:', aiResp.status, t.slice(0, 300));
        return json(
          { error: `Blockbrain ${aiResp.status}: ${t.slice(0, 200)}` },
          aiResp.status === 401 ? 502 : aiResp.status,
          cors
        );
      }
      const ct = aiResp.headers.get('content-type') || '';
      const raw = await aiResp.text();
      console.log('Blockbrain user-input content-type:', ct);
      console.log('Blockbrain user-input raw (first 4000 chars):', raw.slice(0, 4000));
      if (ct.includes('text/event-stream') || raw.startsWith('event:') || raw.startsWith('data:')) {
        assistantText = parseSseContent(raw);
        if (!assistantText) {
          console.error('SSE parse yielded no content. Raw (first 500):', raw.slice(0, 500));
          return json({ error: 'Could not extract content from SSE stream' }, 502, cors);
        }
      } else {
        try {
          const d = JSON.parse(raw);
          assistantText = d.body?.content ?? d.content ?? '';
        } catch (e) {
          console.error('JSON parse failed. Raw (first 500):', raw.slice(0, 500));
          return json({ error: `Cannot parse Blockbrain response: ${e.message}` }, 502, cors);
        }
      }
    } catch (e) {
      console.error('User-input fetch threw:', e.message);
      return json({ error: `User-input failed: ${e.message}` }, 502, cors);
    }

    if (!assistantText) return json({ error: 'Empty response from Blockbrain' }, 502, cors);

    console.log('Assistant response (first 500 chars):', assistantText.slice(0, 500));
    return json({ text: assistantText }, 200, cors);
  },
};

// Parses a Blockbrain SSE response body and concatenates the assistant's
// text content across data: chunks. Critically: skips frames that echo
// the user prompt (event: user_message, role: user, messageType: user-question)
// so we only return what the bot actually said.
function parseSseContent(text) {
  const USER_ECHO_EVENTS = new Set(['user_message', 'user', 'prompt']);
  const lines = text.split(/\r?\n/);
  let out = '';
  let lastAssistantData = null;
  let currentEvent = '';

  for (const line of lines) {
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    let obj;
    try { obj = JSON.parse(payload); }
    catch {
      if (!USER_ECHO_EVENTS.has(currentEvent) && payload) out += payload;
      continue;
    }

    // Skip prompt-echo frames so we never return the user input as the answer
    if (USER_ECHO_EVENTS.has(currentEvent)) continue;
    if (obj.role === 'user') continue;
    if (obj.messageType === 'user-question') continue;

    lastAssistantData = obj;
    if (typeof obj.content === 'string') out += obj.content;
    else if (typeof obj.text === 'string') out += obj.text;
    else if (typeof obj.delta === 'string') out += obj.delta;
    else if (obj.delta?.content) out += obj.delta.content;
    else if (obj.body?.content) out += obj.body.content;
    else if (obj.choices?.[0]?.delta?.content) out += obj.choices[0].delta.content;
  }

  // Fallback: take the last seen assistant frame's content field
  if (!out && lastAssistantData) {
    out =
      lastAssistantData.content ??
      lastAssistantData.text ??
      lastAssistantData.body?.content ??
      lastAssistantData.message?.content ??
      '';
  }
  return out;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
