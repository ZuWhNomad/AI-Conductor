// Private gold answers, reference outputs and seeded mutants for the deterministic B10 fixtures.
// Every exported body carries the grader canary; battery setup/solve strip it before a worker sees it.

export const EXTRACT_NOTES = `// kq7Vx2Lm9Rt4
Dispatch report: north-hub-2026-09-14
All temperatures are Celsius. Keep missing readings as null.

06:30Z — crate A17 — 4.2 — accepted — tags: cold, priority
06:42Z — crate B04 — sensor offline — pending — no tags
07:05Z — crate C22 — 8.7 — rejected — tags: inspect
07:18Z — crate D09 — 3.9 — accepted — tags: cold
`;

export const EXTRACT_GOLD = `// kq7Vx2Lm9Rt4
{
  "report": "north-hub-2026-09-14",
  "unit": "C",
  "readings": [
    { "crate": "A17", "time": "06:30Z", "temperature": 4.2, "disposition": "accepted", "tags": ["cold", "priority"] },
    { "crate": "B04", "time": "06:42Z", "temperature": null, "disposition": "pending", "tags": [] },
    { "crate": "C22", "time": "07:05Z", "temperature": 8.7, "disposition": "rejected", "tags": ["inspect"] },
    { "crate": "D09", "time": "07:18Z", "temperature": 3.9, "disposition": "accepted", "tags": ["cold"] }
  ],
  "totals": { "accepted": 2, "pending": 1, "rejected": 1 }
}
`;

export const CLASSIFY_CASES = `// kq7Vx2Lm9Rt4
[
  { "id": "T01", "text": "My card was charged twice for the same renewal." },
  { "id": "T02", "text": "The CSV export button downloads an empty file." },
  { "id": "T03", "text": "Please add a dark theme to the dashboard." },
  { "id": "T04", "text": "I no longer have access to my old email address and cannot sign in." },
  { "id": "T05", "text": "Where can I download the invoice for September?" },
  { "id": "T06", "text": "Search freezes whenever the query contains an apostrophe." },
  { "id": "T07", "text": "Could saved reports be shared with a team?" },
  { "id": "T08", "text": "The password reset link says it has already expired." },
  { "id": "T09", "text": "We cancelled before renewal but were billed anyway." },
  { "id": "T10", "text": "Notifications show the wrong project name." },
  { "id": "T11", "text": "It would help to schedule exports every Monday." },
  { "id": "T12", "text": "An administrator removed my login by mistake." }
]
`;

export const CLASSIFY_GOLD = `// kq7Vx2Lm9Rt4
[
  { "id": "T01", "label": "billing" },
  { "id": "T02", "label": "bug" },
  { "id": "T03", "label": "feature" },
  { "id": "T04", "label": "account" },
  { "id": "T05", "label": "billing" },
  { "id": "T06", "label": "bug" },
  { "id": "T07", "label": "feature" },
  { "id": "T08", "label": "account" },
  { "id": "T09", "label": "billing" },
  { "id": "T10", "label": "bug" },
  { "id": "T11", "label": "feature" },
  { "id": "T12", "label": "account" }
]
`;

export const SQL_SCHEMA = `// kq7Vx2Lm9Rt4
CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, placed_at TEXT NOT NULL, status TEXT NOT NULL, amount_cents INTEGER NOT NULL);
CREATE TABLE refunds (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL);

INSERT INTO customers VALUES (1, 'Ada', 1), (2, 'Bram', 1), (3, 'Cleo', 0), (4, 'Deni', 1);
INSERT INTO orders VALUES
  (101, 1, '2026-01-08', 'completed', 1000),
  (102, 1, '2026-03-17', 'completed', 2500),
  (103, 1, '2026-02-10', 'cancelled', 9000),
  (104, 2, '2026-01-04', 'completed', 4000),
  (105, 2, '2025-12-31', 'completed', 5000),
  (106, 3, '2026-01-11', 'completed', 600),
  (107, 3, '2026-02-12', 'completed', 700),
  (108, 4, '2026-02-02', 'completed', 700),
  (109, 4, '2026-03-02', 'completed', 800),
  (110, 4, '2026-04-01', 'completed', 1200);
INSERT INTO refunds VALUES (201, 102, 300), (202, 109, 100), (203, 109, 50), (204, 103, 9000);
`;

export const SQL_GOLD = `// kq7Vx2Lm9Rt4
[
  { "customer": "Ada", "order_count": 2, "gross_cents": 3500, "refund_cents": 300, "net_cents": 3200 },
  { "customer": "Deni", "order_count": 2, "gross_cents": 1500, "refund_cents": 150, "net_cents": 1350 }
]
`;

export const SQL_QUERY = `// kq7Vx2Lm9Rt4
WITH q1 AS (
  SELECT o.id, o.customer_id, o.amount_cents,
         COALESCE((SELECT SUM(r.amount_cents) FROM refunds r WHERE r.order_id = o.id), 0) AS refund_cents
  FROM orders o
  WHERE o.status = 'completed' AND o.placed_at >= '2026-01-01' AND o.placed_at < '2026-04-01'
)
SELECT c.name AS customer,
       COUNT(*) AS order_count,
       SUM(q.amount_cents) AS gross_cents,
       SUM(q.refund_cents) AS refund_cents,
       SUM(q.amount_cents - q.refund_cents) AS net_cents
FROM customers c JOIN q1 q ON q.customer_id = c.id
WHERE c.active = 1
GROUP BY c.id, c.name
HAVING COUNT(*) >= 2
ORDER BY c.name;
`;

const REVIEW_FIXED = `// Account and pagination helpers.
export function canViewProject(user, project) {
  return !user.disabled && user.orgId === project.orgId;
}

export function pageCount(total, pageSize) {
  return Math.ceil(total / pageSize);
}

export function appendAudit(existing, event) {
  return [...existing, { ...event }];
}

export async function loadSetting(store, key) {
  return store.get(key);
}
`;

const mark = (body) => `// kq7Vx2Lm9Rt4\n${body}`;
export const REVIEW_MUTANTS = {
  disabled_user: mark(REVIEW_FIXED.replace('return !user.disabled && user.orgId === project.orgId;', 'return user.orgId === project.orgId;')),
  partial_page: mark(REVIEW_FIXED.replace('return Math.ceil(total / pageSize);', 'return Math.floor(total / pageSize);')),
  input_mutation: mark(REVIEW_FIXED.replace('return [...existing, { ...event }];', 'existing.push(event);\n  return existing;')),
  swallowed_error: mark(REVIEW_FIXED.replace('return store.get(key);', "try { return await store.get(key); } catch { return null; }")),
};

export const REVIEW_BUGGY = mark(REVIEW_FIXED
  .replace('return !user.disabled && user.orgId === project.orgId;', 'return user.orgId === project.orgId;')
  .replace('return Math.ceil(total / pageSize);', 'return Math.floor(total / pageSize);')
  .replace('return [...existing, { ...event }];', 'existing.push(event);\n  return existing;')
  .replace('return store.get(key);', "try { return await store.get(key); } catch { return null; }"));

export const REVIEW_GOLD = `// kq7Vx2Lm9Rt4
[3, 7, 11, 16]
`;

export const UI_REFERENCE = `// kq7Vx2Lm9Rt4
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Service overview</title>
  <style>
    body { margin: 0; font: 16px system-ui, sans-serif; background: #f3f5f7; color: #17202a; }
    main { max-width: 900px; margin: 3rem auto; padding: 0 1rem; }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1rem; }
    .card { display: grid; gap: .45rem; padding: 1rem; border: 1px solid #ccd4dc; border-radius: .75rem; background: white; }
    .label { color: #52606d; }
    .value { font-size: 1.6rem; }
    .detail { color: #137333; }
    @media (max-width: 640px) { .cards { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>Service overview</h1>
    <section class="cards" aria-label="Service metrics">
      <article class="card"><span class="label">Availability</span><strong class="value">99.98%</strong><small class="detail">Last 30 days</small></article>
      <article class="card"><span class="label">Latency</span><strong class="value">84 ms</strong><small class="detail">P95 response</small></article>
      <article class="card"><span class="label">Deployments</span><strong class="value">12</strong><small class="detail">This week</small></article>
      <article class="card"><span class="label">Incidents</span><strong class="value">0</strong><small class="detail">Open now</small></article>
    </section>
  </main>
</body>
</html>
`;

export const UI_GOLD = `// kq7Vx2Lm9Rt4
[
  ["Availability", "99.98%", "Last 30 days"],
  ["Latency", "84 ms", "P95 response"],
  ["Deployments", "12", "This week"],
  ["Incidents", "0", "Open now"]
]
`;

export const RESEARCH_EXCERPTS = `// kq7Vx2Lm9Rt4
# Synthetic equity-research excerpts

Excerpt A — operating performance
Alder Systems reported that FY2026 revenue rose 14% to $228 million, while gross margin widened from 41% to 46%. Management attributed most of the margin gain to a richer mix of subscription contracts rather than lower staffing costs.

Excerpt B — investment and liquidity
Brindle Components ended the quarter with $72 million of cash and no long-term debt. The company expects capital spending of $18 million in FY2027, primarily for a second assembly line scheduled to enter service in October.

Excerpt C — market conditions
Industry shipments are forecast to grow 9% next year as regional grid upgrades accelerate. Component lead times have fallen from 11 weeks to 7 weeks, which may ease pricing power for suppliers.
`;

const number = (n) => {
  const [whole, fraction] = String(n).split('.');
  if (fraction == null || !fraction.replace(/0+$/, '')) return `${whole}(?:\\.0+)?`;
  return `${whole}\\.${fraction.replace(/0+$/, '')}0*`;
};
const numeric = (n) => `(?<![\\d.])${number(n)}(?!\\d)`;
const pct = (n) => `${numeric(n)}\\s*(?:%|percent|per\\s+cent)`;
const currency = (n) => `(?<![\\d.])(?:\\$\\s*|USD\\s*)?${number(n)}(?:\\s+dollars?)?(?!\\d)`;
export const money = (n, unit) => `(?<![\\d.])(?:\\$\\s*|USD\\s*)?${number(n)}\\s*(?:${unit}|${unit === 'million' ? 'm|mn' : 'b|bn'})(?:\\s+dollars?)?\\b`;
const count = (n, word, unit) => `(?:${n}|${word})\\s+${unit}`;
const dash = '[-\\u2010-\\u2015]';

export const RESEARCH_GOLD = `// kq7Vx2Lm9Rt4
[
  {
    "id": "Q1",
    "citation": "Excerpt A",
    "quote": "Alder Systems reported that FY2026 revenue rose 14% to $228 million, while gross margin widened from 41% to 46%.",
    "claims": [
      ["revenue", ${JSON.stringify(pct(14))}, ${JSON.stringify(money(228, 'million'))}],
      ["gross margin", ${JSON.stringify(pct(41))}, ${JSON.stringify(pct(46))}]
    ]
  },
  {
    "id": "Q2",
    "citation": "Excerpt B",
    "quote": "Brindle Components ended the quarter with $72 million of cash and no long-term debt.",
    "claims": [
      [${JSON.stringify(money(72, 'million'))}, "cash", ${JSON.stringify(`no\\s+long(?:${dash}|\\s)+term\\s+debt`)}],
      ["capital spending|capital expenditures?|capex", ${JSON.stringify(money(18, 'million'))}, "second assembly line", "October"]
    ]
  },
  {
    "id": "Q3",
    "citation": "Excerpt C",
    "quote": "Component lead times have fallen from 11 weeks to 7 weeks, which may ease pricing power for suppliers.",
    "claims": [
      ["shipments?", ${JSON.stringify(pct(9))}, "grid upgrades"],
      ["lead times", ${JSON.stringify(`(?:11|eleven)(?:\\s+weeks|\\s*(?:to|${dash})\\s*(?:7|seven)\\s+weeks)`)}, ${JSON.stringify(`(?:7|seven)\\s+weeks`)}, "pricing power"]
    ]
  }
]
`;

export const RESEARCH_REFERENCE = `// kq7Vx2Lm9Rt4
## Q1 — Operating performance
### Claims
- Revenue increased 14% to $228 million in FY2026.
- Gross margin expanded from 41% to 46%.
### Citation
[Excerpt A]
### Quote
"Alder Systems reported that FY2026 revenue rose 14% to $228 million, while gross margin widened from 41% to 46%."

## Q2 — Balance sheet and planned investment
### Claims
- Brindle finished the quarter with $72 million in cash and no long-term debt.
- Planned capital spending is $18 million for a second assembly line due in October.
### Citation
[Excerpt B]
### Quote
"Brindle Components ended the quarter with $72 million of cash and no long-term debt."

## Q3 — Market opportunity and risk
### Claims
- Industry shipments are forecast to grow 9% as regional grid upgrades accelerate.
- Lead times fell from 11 weeks to 7 weeks, which may weaken supplier pricing power.
### Citation
[Excerpt C]
### Quote
"Component lead times have fallen from 11 weeks to 7 weeks, which may ease pricing power for suppliers."
`;

export const WRITING_CREATIVE_REFERENCE = `// kq7Vx2Lm9Rt4
TITLE: The Last Light
BODY:
Rain stitched silver lines across the harbor when Mara found the brass lantern beneath the pier. Its glass was warm, though the wick was dark. She raised it, and every moored boat answered with a single knock against the quay. Across the water, an unlit buoy began to blink in time with her pulse. Mara wanted to run, but the tide had already covered the steps behind her. She turned the lantern's tiny wheel. A gold beam swept the fog, revealing a narrow channel where no chart showed one. The boats loosened their own ropes and followed. At dawn, the harbor answered.
`;

export const WRITING_COPY_REFERENCE = `// kq7Vx2Lm9Rt4
HEADLINE: Keep every thought within reach
SUBHEAD: QuietDesk keeps focused notes ready wherever work happens.
- Write offline during a commute, then sync across desktop and mobile when you reconnect.
- Find projects quickly with a calm, distraction-free workspace.
- Pay $8/month after a 14-day free trial with no credit card required.
CTA: Start your 14-day free trial.
`;

export const VIDEO_TRANSCRIPT = `// kq7Vx2Lm9Rt4
WEBVTT

00:00:04.000 --> 00:00:10.000
The pilot enrolled 120 households across three neighborhoods. Enrollment was distributed across the full service area.

00:00:15.000 --> 00:00:22.000
During the six-week trial, peak electricity demand fell by 8 percent. The comparison used each household's pre-trial peak.

00:00:28.000 --> 00:00:35.000
No battery faults were reported, although two homes lost Wi-Fi briefly. Both connections recovered without a site visit.
`;

export const VIDEO_GOLD = `// kq7Vx2Lm9Rt4
[
  {
    "timestamp": "00:07",
    "start": 4,
    "end": 10,
    "claim": "The pilot enrolled 120 households in three neighborhoods.",
    "quote": "The pilot enrolled 120 households across three neighborhoods.",
    "patterns": [${JSON.stringify(`${numeric(120)}\\s+households`)}, ${JSON.stringify(`(?:3|three)\\s+neighborhoods`)}]
  },
  {
    "timestamp": "00:18",
    "start": 15,
    "end": 22,
    "claim": "Peak electricity demand fell 8 percent during the six-week trial.",
    "quote": "During the six-week trial, peak electricity demand fell by 8 percent.",
    "patterns": ["peak electricity demand", ${JSON.stringify(pct(8))}, ${JSON.stringify(`(?:6|six)(?:${dash}|\\s)+week\\s+trial`)}]
  },
  {
    "timestamp": "00:31",
    "start": 28,
    "end": 35,
    "claim": "No battery faults were reported, but two homes briefly lost Wi-Fi.",
    "quote": "No battery faults were reported, although two homes lost Wi-Fi briefly.",
    "patterns": ["(?:no|zero)\\\\s+battery faults?", "(?:2|two)\\\\s+homes", "Wi(?:[-\\\\u2010-\\\\u2015]|\\\\s)?Fi"]
  }
]
`;

// research-4 / research-5: long synthetic filing packs. Fact sentences are inserted only after the
// seeded boilerplate prefix, so each needed fact sits outside the first and last 3,000 characters.
// Document text is not exported (it is a worker fixture and must not carry the canary). The reference
// answers are exported and do carry it. `rng` matches private/common.mjs; this module does not import
// the battery.
const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const FILL = ['operating', 'review', 'committee', 'period', 'customer', 'contract', 'facility', 'supply', 'regional', 'demand', 'volume', 'margin', 'inventory', 'seasonal', 'maintenance', 'compliance', 'insurance', 'litigation', 'personnel', 'accounting', 'estimate', 'disclosure', 'segment', 'capacity', 'freight', 'energy', 'weather', 'regulation', 'credit', 'vendor', 'schedule', 'warehouse', 'invoice', 'forecast', 'overhead', 'warranty', 'pension', 'lease', 'audit', 'tax'];
const fillerSentence = (rand) => {
  const n = 14 + Math.floor(rand() * 8), words = [];
  for (let i = 0; i < n; i++) words.push(FILL[Math.floor(rand() * FILL.length)]);
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return `${words.join(' ')}.`;
};
const fillerBlock = (rand, chars) => {
  let s = '';
  while (s.length < chars) {
    const lines = [];
    const k = 4 + Math.floor(rand() * 3);
    for (let i = 0; i < k; i++) lines.push(fillerSentence(rand));
    s += `${lines.join(' ')}\n\n`;
  }
  return s;
};
/** Long markdown document: heading, ≥3,500 characters of boilerplate, the fact sentences, then enough boilerplate that every fact is also ≥3,000 characters from the end. */
function longDoc(rand, heading, facts, minChars) {
  const head = `# ${heading}\n\n`;
  const pre = fillerBlock(rand, 3500);
  const mid = facts.length ? `${facts.join('\n\n')}\n\n` : '';
  let post = fillerBlock(rand, 3500);
  while (head.length + pre.length + mid.length + post.length < minChars) post += fillerBlock(rand, 2000);
  return head + pre + mid + post;
}

const R4_REV = 'Corvane Grid Systems reported third-quarter revenue of $412 million and diluted earnings per share of $2.18.';
const R4_CASH = 'Cash and cash equivalents were $86 million at quarter end.';
const R4_SPOT = 'The common stock closed at $160.00 on the earnings date.';
const R4_CONSENSUS = 'The published consensus for diluted earnings per share this quarter was $2.05.';
const R4_BACKLOG_STALE = 'The analyst note records an order backlog of $1.40 billion, a figure prepared before the quarter closed.';
const R4_TARGET = 'The note sets a twelve-month price target of $300 by applying a 24 times multiple to an earnings basis of $8.50.';
const R4_BACKLOG = 'The company reported a current order backlog of $1.62 billion as of the quarter-end balance-sheet date.';

const R4_REFERENCE = `## R1 — Quarter versus consensus
### Answer
Third-quarter revenue was $412 million and diluted EPS was $2.18. The published consensus EPS was $2.05, so the quarter beat consensus by $0.13.
### Citation
[8-K]
### Quote
"${R4_REV}"

## R2 — Order backlog
### Answer
The 10-Q reports a current order backlog of $1.62 billion. The analyst note's $1.40 billion backlog conflicts with that later figure and is stale.
### Citation
[10-Q]
### Quote
"${R4_BACKLOG}"

## R3 — Price target
### Answer
The note states a twelve-month price target of $300, which is inconsistent with a 24 times multiple applied to an earnings basis of $8.50. The corrected product is $204 and that corrected figure is the target.
### Citation
[Analyst Note]
### Quote
"${R4_TARGET}"

## R4 — Implied return and rating
### Answer
The corrected target of $204 against a spot price of $160.00 implies a return of 27.5%.
Rating: BUY
### Citation
[8-K]
### Quote
"${R4_SPOT}"

## R5 — Cash
### Answer
Cash and cash equivalents were $86 million at quarter end.
### Citation
[10-Q]
### Quote
"${R4_CASH}"
`;

let pack4;
export function research4Pack() {
  if (pack4) return pack4;
  const rand = rng(45);
  const files = {
    'filings/10-K.md': longDoc(rand, 'Corvane Grid Systems Form 10-K', [], 38000),
    'filings/8-K-earnings.md': longDoc(rand, 'Corvane Grid Systems Form 8-K earnings', [R4_REV, R4_CASH, R4_SPOT], 38000),
    'filings/analyst-note.md': longDoc(rand, 'Corvane Grid Systems analyst note', [R4_CONSENSUS, R4_BACKLOG_STALE, R4_TARGET], 38000),
    'filings/10-Q.md': longDoc(rand, 'Corvane Grid Systems Form 10-Q', [R4_BACKLOG, R4_CASH], 38000),
  };
  const anchor = (file, sentence) => ({ file, sentence });
  pack4 = {
    files,
    docs: { '10-K': 'filings/10-K.md', '10-Q': 'filings/10-Q.md', '8-K': 'filings/8-K-earnings.md', 'Analyst Note': 'filings/analyst-note.md' },
    prefix: 'R',
    anchors: [
      anchor('filings/8-K-earnings.md', R4_REV), anchor('filings/8-K-earnings.md', R4_CASH), anchor('filings/8-K-earnings.md', R4_SPOT),
      anchor('filings/analyst-note.md', R4_CONSENSUS), anchor('filings/analyst-note.md', R4_BACKLOG_STALE), anchor('filings/analyst-note.md', R4_TARGET),
      anchor('filings/10-Q.md', R4_BACKLOG), anchor('filings/10-Q.md', R4_CASH),
    ],
    items: [
      { id: 'R1', quote: R4_REV, claims: [[money(412, 'million')], [currency('2.18')], [currency('2.05')], ['beat|exceed', currency('0.13')]] },
      { id: 'R2', quote: R4_BACKLOG, trap: 'backlog', claims: [[money('1.62', 'billion')], [money('1.40', 'billion')], ['conflict|contradict|differ|inconsisten|stale|older|supersed|disagree|before (?:the )?quarter|pre-quarter']] },
      { id: 'R3', quote: R4_TARGET, trap: 'target', claims: [[currency(204)], [numeric(24)], [currency('8.50')]] },
      { id: 'R4', quote: R4_SPOT, trap: 'rating', rating: 'BUY', claims: [[numeric('27.5')]] },
      { id: 'R5', quote: R4_CASH, claims: [[money(86, 'million')]] },
    ],
  };
  return pack4;
}
export const RESEARCH4_REFERENCE = `// kq7Vx2Lm9Rt4\n${R4_REFERENCE}`;

const R5_SEGMENTS = 'Industrial products accounted for 54 percent of net revenue, consumer packaging for 31 percent, and all other activities for 15 percent.';
const R5_RISK_FIBER = 'A sustained rise in recovered-fiber prices would compress margins before contracts reset.';
const R5_RISK_PORT = 'The company depends on a single port terminal for export shipments.';
const R5_CEO = 'Ada Pell has served as chief executive officer for 6 years and previously was chief financial officer of Northline Pulp.';
const R5_CFO = 'Jon Vesper has served as chief financial officer for 3 years and previously was treasurer of Kite Board Company.';
const R5_MATRIX = 'The board diversity matrix reports that 4 of 9 directors are women and that 3 of 9 directors self-identify as members of an underrepresented group.';
const R5_ROSTER = ['Ada Pell', 'Jon Vesper', 'Ruth Hale', 'Omar Shah', 'Priya Nunez', 'Cole Brandt', 'Helen Cho', 'Marco Ibarra', 'June Okada'];
const R5_DIVIDEND = 'The quarterly report describes capital returns only by reference to the dividend of $12 million declared in March.';
const R5_MILL = 'The Redhook mill remains in service and no closure has been authorized.';
const R5_GUIDE = 'Management set full-year net revenue guidance at $900 million.';
const R5_GUIDE_STALE = 'An earlier desk note had repeated full-year net revenue guidance of $840 million.';
const R5_MILL_NEWS = 'Local press reported that the Redhook mill would close in November.';

const R5_REFERENCE = `## D1 — Segments
### Answer
Industrial products accounted for 54 percent of net revenue, consumer packaging for 31 percent, and all other activities for 15 percent.
### Citation
[10-K]
### Quote
"${R5_SEGMENTS}"

## D2 — Leadership
### Answer
Ada Pell has served as chief executive officer for 6 years and previously was chief financial officer of Northline Pulp. Jon Vesper has served as chief financial officer for 3 years and previously was treasurer of Kite Board Company.
### Citation
[DEF 14A]
### Quote
"${R5_CEO}"

## D3 — Board diversity
### Answer
The company's matrix reports the aggregate only: 4 of 9 directors are women.
### Citation
[DEF 14A]
### Quote
"${R5_MATRIX}"

## D4 — Buyback authorization
### Answer
A share repurchase authorization was not disclosed in the sources.
### Citation
[10-Q]
### Quote
"${R5_DIVIDEND}"

## D5 — Guidance
### Answer
The latest full-year net revenue guidance is $900 million. The $840 million figure repeated in the news item is stale.
### Citation
[Transcript]
### Quote
"${R5_GUIDE}"

## D6 — Principal risks
### Answer
One risk is that a sustained rise in recovered-fiber prices would compress margins. Another is dependence on a single port terminal for export shipments.
### Citation
[10-K]
### Quote
"${R5_RISK_FIBER}"
`;

let pack5;
export function research5Pack() {
  if (pack5) return pack5;
  const rand = rng(54);
  const roster = `${R5_ROSTER.map((name, i) => `${i + 1}. ${name} is a director.`).join(' ')}`;
  const files = {
    'sources/10-K.md': longDoc(rand, 'Pellam Harbor Mills Form 10-K', [R5_SEGMENTS, R5_RISK_FIBER, R5_RISK_PORT], 21000),
    'sources/proxy-DEF14A.md': longDoc(rand, 'Pellam Harbor Mills DEF 14A', [roster, R5_CEO, R5_CFO, R5_MATRIX], 21000),
    'sources/10-Q.md': longDoc(rand, 'Pellam Harbor Mills Form 10-Q', [R5_DIVIDEND, R5_MILL], 21000),
    'sources/transcript.md': longDoc(rand, 'Pellam Harbor Mills earnings call', [R5_GUIDE], 21000),
    'sources/news.md': longDoc(rand, 'Pellam Harbor Mills news items', [R5_GUIDE_STALE, R5_MILL_NEWS], 21000),
  };
  const anchor = (file, sentence) => ({ file, sentence });
  pack5 = {
    files,
    docs: { '10-K': 'sources/10-K.md', 'DEF 14A': 'sources/proxy-DEF14A.md', '10-Q': 'sources/10-Q.md', Transcript: 'sources/transcript.md', News: 'sources/news.md' },
    prefix: 'D',
    roster: R5_ROSTER,
    anchors: [
      anchor('sources/10-K.md', R5_SEGMENTS), anchor('sources/10-K.md', R5_RISK_FIBER), anchor('sources/10-K.md', R5_RISK_PORT),
      anchor('sources/proxy-DEF14A.md', roster), anchor('sources/proxy-DEF14A.md', R5_CEO), anchor('sources/proxy-DEF14A.md', R5_CFO), anchor('sources/proxy-DEF14A.md', R5_MATRIX),
      anchor('sources/10-Q.md', R5_DIVIDEND), anchor('sources/10-Q.md', R5_MILL),
      anchor('sources/transcript.md', R5_GUIDE),
      anchor('sources/news.md', R5_GUIDE_STALE), anchor('sources/news.md', R5_MILL_NEWS),
    ],
    items: [
      { id: 'D1', quote: R5_SEGMENTS, claims: [['[Ii]ndustrial', pct(54)], ['consumer packaging', pct(31)], [pct(15)]] },
      { id: 'D2', quote: R5_CEO, claims: [['Ada Pell', count(6, 'six', 'years?'), 'Northline Pulp'], ['Jon Vesper', count(3, 'three', 'years?'), 'Kite Board']] },
      { id: 'D3', quote: R5_MATRIX, trap: 'aggregate', claims: [['\\b(?:4|four)\\b', '\\b(?:9|nine)\\b', 'women']] },
      { id: 'D4', quote: R5_DIVIDEND, trap: 'absent', claims: [['not\\s+(?:disclosed|found|reported|mentioned)|(?:do|does)\\s+not\\s+(?:disclose|report|mention)|(?:disclose|report|mention)(?:s|ed)?\\s+no|no\\s+(?:share\\s+)?(?:repurchase|buyback)\\s+authorization']] },
      { id: 'D5', quote: R5_GUIDE, trap: 'guidance', claims: [[money(900, 'million')], [money(840, 'million')], ['stale|outdated|earlier|previous|older|supersed|conflict|contradict|differ|inconsisten|disagree']] },
      { id: 'D6', quotes: [R5_RISK_FIBER, R5_RISK_PORT], claims: [[`recovered(?:${dash}|\\s)+fiber`], ['port terminal']] },
    ],
  };
  return pack5;
}
export const RESEARCH5_REFERENCE = `// kq7Vx2Lm9Rt4\n${R5_REFERENCE}`;
