/**
 * Dev-only mock of the Management API endpoints the Quota page touches, with
 * Vite reverse-proxied behind it so the app and the API share one origin.
 *
 *   bun run dev -- --port 5199 &   # Vite
 *   bun scripts/mock-quota-backend.ts --port 18317 --vite http://127.0.0.1:5199
 *   open http://127.0.0.1:18317/#/quota   (auto-logged-in with a fake key)
 *
 * Data is synthetic: six Claude accounts, three Codex, one each of xAI, Kimi
 * and Meta, plus four days of recorded pool history. No real credentials.
 */

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const PORT = Number(args.get('--port') ?? 18317);
const VITE = args.get('--vite') ?? 'http://127.0.0.1:5199';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const now = Date.now();

type ClaudeAccount = {
  index: string;
  label: string;
  email: string;
  sevenDayUsed: number;
  sevenDayResetMs: number;
  fiveHourUsed: number;
  fiveHourResetMs: number | null;
  fableUsed: number;
  refreshedAgoMs: number;
};

const at = (hoursFromNow: number) => now + hoursFromNow * HOUR;

const claude: ClaudeAccount[] = [
  { index: 'c1', label: 't3 6', email: 't3-6@example.dev', sevenDayUsed: 2, sevenDayResetMs: at(49), fiveHourUsed: 0, fiveHourResetMs: null, fableUsed: 0, refreshedAgoMs: 14 * 60_000 },
  { index: 'c2', label: 'gmail', email: 'someone@gmail.example', sevenDayUsed: 0, sevenDayResetMs: at(78), fiveHourUsed: 0, fiveHourResetMs: null, fableUsed: 0, refreshedAgoMs: 14 * 60_000 },
  { index: 'c3', label: '10xn', email: 'ops@10xn.example', sevenDayUsed: 0, sevenDayResetMs: at(160), fiveHourUsed: 0, fiveHourResetMs: null, fableUsed: 0, refreshedAgoMs: 14 * 60_000 },
  { index: 'c4', label: 't3 7', email: 't3-7@example.dev', sevenDayUsed: 27, sevenDayResetMs: at(37), fiveHourUsed: 7, fiveHourResetMs: at(3.67), fableUsed: 0, refreshedAgoMs: 20_000 },
  { index: 'c5', label: 't3 1', email: 't3-1@example.dev', sevenDayUsed: 0, sevenDayResetMs: at(65), fiveHourUsed: 0, fiveHourResetMs: null, fableUsed: 0, refreshedAgoMs: 14 * 60_000 },
  { index: 'c6', label: 't3 2', email: 't3-2@example.dev', sevenDayUsed: 1, sevenDayResetMs: at(146), fiveHourUsed: 0, fiveHourResetMs: null, fableUsed: 0, refreshedAgoMs: 14 * 60_000 },
];

type CodexAccount = {
  index: string;
  label: string;
  email: string;
  weeklyUsed: number;
  weeklyResetMs: number;
  primaryUsed: number;
  primaryResetMs: number;
};

const codex: CodexAccount[] = [
  { index: 'x1', label: 'work', email: 'work@example.dev', weeklyUsed: 64, weeklyResetMs: at(30), primaryUsed: 22, primaryResetMs: at(2.5) },
  { index: 'x2', label: 'personal', email: 'me@example.dev', weeklyUsed: 18, weeklyResetMs: at(101), primaryUsed: 0, primaryResetMs: at(5) },
  { index: 'x3', label: 'spare', email: 'spare@example.dev', weeklyUsed: 3, weeklyResetMs: at(140), primaryUsed: 0, primaryResetMs: at(5) },
];

const iso = (ms: number) => new Date(ms).toISOString();

const fileEntry = (
  provider: string,
  index: string,
  label: string,
  email: string,
  extra: Record<string, unknown> = {}
) => ({
  id: `${provider}-${index}.json`,
  name: `${provider}-${email}.json`,
  label,
  email,
  account: email,
  account_type: 'oauth',
  auth_index: index,
  type: provider,
  provider,
  disabled: false,
  status: 'active',
  cooldowns: [],
  created_at: iso(now - 30 * DAY),
  last_refresh: iso(now - HOUR),
  ...extra,
});

const files = [
  ...claude.map((a) => fileEntry('claude', a.index, a.label, a.email)),
  ...codex.map((a) => fileEntry('codex', a.index, a.label, a.email)),
  fileEntry('xai', 'g1', 'grok', 'grok@example.dev'),
  fileEntry('kimi', 'k1', 'kimi', 'kimi@example.dev'),
  fileEntry('meta', 'm1', 'muse', 'muse@example.dev'),
];

const claudeUsage = (a: ClaudeAccount) => ({
  five_hour: {
    utilization: a.fiveHourUsed,
    resets_at: a.fiveHourResetMs ? iso(a.fiveHourResetMs) : null,
  },
  seven_day: { utilization: a.sevenDayUsed, resets_at: iso(a.sevenDayResetMs) },
  seven_day_opus: null,
  seven_day_sonnet: null,
  iguana_necktie: null,
  extra_usage: { is_enabled: false },
  limits: [
    { kind: 'session', group: 'session', percent: a.fiveHourUsed, resets_at: a.fiveHourResetMs ? iso(a.fiveHourResetMs) : null, scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: a.sevenDayUsed, resets_at: iso(a.sevenDayResetMs), scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: a.fableUsed, resets_at: iso(a.sevenDayResetMs), scope: { model: { id: null, display_name: 'Fable 5' } }, is_active: false },
  ],
});

const codexUsage = (a: CodexAccount) => ({
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: a.primaryUsed,
      limit_window_seconds: 5 * 3600,
      reset_after_seconds: Math.round((a.primaryResetMs - now) / 1000),
      reset_at: Math.round(a.primaryResetMs / 1000),
    },
    secondary_window: {
      used_percent: a.weeklyUsed,
      limit_window_seconds: 7 * 24 * 3600,
      reset_after_seconds: Math.round((a.weeklyResetMs - now) / 1000),
      reset_at: Math.round(a.weeklyResetMs / 1000),
    },
  },
});

/**
 * Four days of history. Each account drains in bursts during "work hours"
 * and jumps back to 0% used at its weekly reset, which is how real recorded
 * samples look. The final sample of each account equals its current usage.
 */
function buildHistory(hours: number) {
  const samples: unknown[] = [];
  const start = now - Math.min(hours, 96) * HOUR;
  const step = 20 * 60_000;
  const workHour = (ms: number) => {
    const h = new Date(ms).getHours();
    return h >= 9 && h <= 23;
  };
  const series = <T extends { index: string }>(
    accounts: T[],
    provider: string,
    current: (a: T) => number,
    resetMs: (a: T) => number,
    rate: (a: T) => number,
    windowsFor: (a: T, used: number, reset: number) => Record<string, unknown>
  ) => {
    for (const a of accounts) {
      // Walk backwards from now so the last point matches the live value.
      const points: { t: number; used: number; reset: number }[] = [];
      let used = current(a);
      let reset = resetMs(a);
      for (let t = now; t >= start; t -= step) {
        points.push({ t, used: Math.max(0, Math.min(100, used)), reset });
        const prev = t - step;
        if (prev < reset - WEEK) {
          // Crossing backwards over the previous reset: before it the account
          // was near the end of its old week, mostly spent.
          reset -= WEEK;
          used = 35 + ((a.index.charCodeAt(1) * 7) % 30);
        } else {
          const weight = workHour(prev) ? 1 : 0.35;
          used -= rate(a) * weight * (step / HOUR) * (0.5 + Math.random());
        }
      }
      for (const p of points.reverse()) {
        samples.push({
          t: p.t,
          auth_index: a.index,
          provider,
          source: 'passive',
          windows: windowsFor(a, Math.round(p.used * 10) / 10, p.reset),
        });
      }
    }
  };
  series(
    claude,
    'claude',
    (a) => a.sevenDayUsed,
    (a) => a.sevenDayResetMs,
    (a) => (a.index === 'c4' ? 1.3 : a.index === 'c1' ? 0.5 : 0.35),
    (_a, used, reset) => ({ seven_day: { used, reset_at: reset } })
  );
  series(
    codex,
    'codex',
    (a) => a.weeklyUsed,
    (a) => a.weeklyResetMs,
    (a) => (a.index === 'x1' ? 1.1 : 0.3),
    (_a, used, reset) => ({ secondary: { used, reset_at: reset, window_minutes: 10080 } })
  );
  samples.sort((x, y) => (x as { t: number }).t - (y as { t: number }).t);
  return samples;
}

const history = buildHistory(96);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': '*',
  'X-CPA-Version': 'v8.0.0-mock',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });

const apiCall = (body: { authIndex?: string; url?: string }) => {
  const url = body.url ?? '';
  const ca = claude.find((a) => a.index === body.authIndex);
  if (ca) {
    if (url.includes('/oauth/profile')) {
      return { status_code: 200, header: {}, body: { account: { has_claude_max: true } } };
    }
    return { status_code: 200, header: {}, body: claudeUsage(ca) };
  }
  const xa = codex.find((a) => a.index === body.authIndex);
  if (xa) {
    if (url.includes('/wham/usage')) return { status_code: 200, header: {}, body: codexUsage(xa) };
    return { status_code: 404, header: {}, body: { error: 'not mocked' } };
  }
  return { status_code: 401, header: {}, body: { error: { message: 'token expired' } } };
};

const SEED = `<script>
  if (!localStorage.getItem('isLoggedIn')) {
    localStorage.setItem('apiBase', location.origin);
    localStorage.setItem('managementKey', 'mock-key');
    localStorage.setItem('isLoggedIn', 'true');
  }
</script>`;

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname.startsWith('/v8/management') || url.pathname.startsWith('/v0/management')) {
      const path = url.pathname.replace(/^\/v[08]\/management/, '');
      if (path === '/credentials' && req.method === 'GET') {
        return json({ files, observed_at: iso(now) });
      }
      if (path === '/requests/api-call') {
        const body = (await req.json().catch(() => ({}))) as { authIndex?: string; url?: string };
        await Bun.sleep(150 + Math.random() * 350);
        return json(apiCall(body));
      }
      if (path === '/quota/history') {
        if (req.method === 'POST') return json({ status: 'ok' });
        const hours = Number(url.searchParams.get('hours') ?? 336);
        const since = Date.now() - hours * HOUR;
        return json({ now: Date.now(), samples: history.filter((s) => (s as { t: number }).t >= since) });
      }
      if (path === '/config') {
        return json({ routing: { strategy: 'soonest-reset' }, 'debug': false });
      }
      return json({});
    }

    const upstream = await fetch(VITE + url.pathname + url.search, {
      method: req.method,
      headers: req.headers,
    });
    const type = upstream.headers.get('content-type') ?? '';
    if (type.includes('text/html')) {
      const html = (await upstream.text()).replace('<head>', `<head>${SEED}`);
      return new Response(html, { status: upstream.status, headers: { 'Content-Type': type } });
    }
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  },
});

console.log(`mock quota backend on http://127.0.0.1:${PORT} (vite ${VITE})`);
