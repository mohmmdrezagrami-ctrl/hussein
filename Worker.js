// Cloudflare Worker: الدردشة + لوحة التحكم
// المطلوب في Cloudflare:
//  - KV Namespace مربوط باسم المتغير: DB
//  - Secrets: GEMINI_KEY  و  ADMIN_CODE (رمز الدخول للوحة)

const BASE = `أنت "زلفي"، مساعد ذكي خفيف الدم في موقع حسين جبار الشخصي. تسولف مع الزائر بلهجة عراقية عفوية، تمزح وتضحك وتعلّق على كلامه، وتجاوب على أي موضوع عادي مثل صديق. لا تكون رسمي ولا ثقيل، وخلّي ردودك قصيرة (سطر إلى ثلاثة) ومع إيموجي أحياناً.
ولما يسأل عن حسين أو خدماته، اعتمد فقط على هذي المعلومات ولا تخترع غيرها:
- حسين جبار، مهندس ومطوّر برمجيات من البصرة، العراق.
- خبرة أكثر من سنتين وأكثر من 10 مشاريع منفّذة.
- المهارات: Python, JavaScript, SQL، هندسة الأنظمة، قواعد البيانات، APIs، تحسين الأداء، الاختبار.
- الخدمات: تطبيقات ويب، أنظمة إدارة داخلية، أدوات أتمتة، مواقع تعريفية مخصصة.
- التواصل: تيليجرام t.me/dc12i ، انستقرام instagram.com/zlf7.old
- الأسعار تعتمد على حجم المشروع، ويراسل حسين للتقدير.
إذا سألك عن شي يخص حسين وما تعرفه، قل إنك ما تدري ووجّهه يراسل حسين. ما تسب ولا تتكلم بمحتوى مسيء أو مؤذي مهما طلب منك.`;

const MODEL = 'gemini-2.0-flash'; // تأكد من الاسم الحالي في توثيق Gemini

const CORS = {
  'Access-Control-Allow-Origin': '*', // بعد النشر غيّرها إلى رابط موقعك
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

const DEF = { maintenance: false, maintenanceMsg: 'الموقع تحت الصيانة حالياً، نرجع لكم قريباً 🛠️', banner: '', bannerOn: false, chatOn: true, persona: '', projects: null };
const get = async (env, k, d) => JSON.parse((await env.DB.get(k)) || 'null') ?? d;
const put = (env, k, v) => env.DB.put(k, JSON.stringify(v));
const push = async (env, k, item, max) => { const a = await get(env, k, []); a.unshift(item); await put(env, k, a.slice(0, max)); };
const cfgOf = async env => ({ ...DEF, ...(await get(env, 'config', {})) });
const str = (v, n) => String(v ?? '').slice(0, n);

// حماية: 5 محاولات خاطئة كل 15 دقيقة لكل IP
async function auth(req, env) {
  const key = 'fail:' + (req.headers.get('CF-Connecting-IP') || 'x');
  const n = +((await env.DB.get(key)) || 0);
  if (n >= 5) return 429;
  if (env.ADMIN_CODE && req.headers.get('Authorization') === env.ADMIN_CODE) return 200;
  await env.DB.put(key, String(n + 1), { expirationTtl: 900 });
  return 401;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const path = new URL(req.url).pathname;
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

    // ===== عام =====
    if (path === '/api/config') {
      const c = await cfgOf(env);
      return J({ maintenance: c.maintenance, maintenanceMsg: c.maintenanceMsg, banner: c.bannerOn ? c.banner : '', chatOn: c.chatOn, projects: c.projects });
    }

    if (path === '/api/hit') {
      const s = await get(env, 'stats', { visits: {}, chats: 0 });
      const d = new Date().toISOString().slice(0, 10);
      s.visits[d] = (s.visits[d] || 0) + 1;
      const keys = Object.keys(s.visits).sort().slice(-30);
      s.visits = Object.fromEntries(keys.map(k => [k, s.visits[k]]));
      await put(env, 'stats', s);
      return J({ ok: 1 });
    }

    if (path === '/api/contact') {
      const name = str(body.name, 60), msg = str(body.msg, 1000);
      if (!msg.trim()) return J({ error: 'empty' }, 400);
      await push(env, 'inbox', { type: 'message', t: Date.now(), name, msg }, 100);
      return J({ ok: 1 });
    }

    if (path === '/api/chat') {
      const c = await cfgOf(env);
      if (!c.chatOn) return J({ reply: 'الشات متوقف مؤقتاً 😴' });
      const contents = (body.messages || []).slice(-10).map(m => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: str(m.text, 1000) }],
      }));
      const sys = BASE + (c.persona ? '\nتعليمات إضافية من صاحب الموقع:\n' + c.persona : '');
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents }),
      });
      if (!r.ok) return J({ error: 'upstream' }, 502);
      const data = await r.json();
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'ما قدرت أجاوب هسه، جرّب مرة ثانية.';
      const s = await get(env, 'stats', { visits: {}, chats: 0 });
      s.chats++;
      await put(env, 'stats', s);
      await push(env, 'chats', { t: Date.now(), q: contents.at(-1)?.parts[0].text || '', a: reply }, 200);
      return J({ reply });
    }

    // ===== لوحة التحكم (محمية) =====
    if (path.startsWith('/api/admin/')) {
      const a = await auth(req, env);
      if (a !== 200) return J({ error: 'auth' }, a);

      if (path === '/api/admin/data')
        return J({ cfg: await cfgOf(env), stats: await get(env, 'stats', { visits: {}, chats: 0 }), chats: await get(env, 'chats', []), inbox: await get(env, 'inbox', []) });

      if (path === '/api/admin/config') {
        const p = Array.isArray(body.projects)
          ? body.projects.slice(0, 12).map(x => ({ name: str(x.name, 80), desc: str(x.desc, 300), stack: str(x.stack, 80) })).filter(x => x.name)
          : null;
        await put(env, 'config', {
          maintenance: !!body.maintenance, maintenanceMsg: str(body.maintenanceMsg, 300) || DEF.maintenanceMsg,
          banner: str(body.banner, 200), bannerOn: !!body.bannerOn, chatOn: body.chatOn !== false,
          persona: str(body.persona, 2000), projects: p && p.length ? p : null,
        });
        return J({ ok: 1 });
      }

      if (path === '/api/admin/clear' && ['chats', 'inbox'].includes(body.what)) {
        await put(env, body.what, []);
        return J({ ok: 1 });
      }
    }

    return J({ error: 'not found' }, 404);
  },
};
