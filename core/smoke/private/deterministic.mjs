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

export const RESEARCH_GOLD = `// kq7Vx2Lm9Rt4
[
  {
    "id": "Q1",
    "citation": "Excerpt A",
    "quote": "Alder Systems reported that FY2026 revenue rose 14% to $228 million, while gross margin widened from 41% to 46%.",
    "claims": [
      ["revenue", "14\\\\s*%", "228\\\\s+million"],
      ["gross margin", "41\\\\s*%", "46\\\\s*%"]
    ]
  },
  {
    "id": "Q2",
    "citation": "Excerpt B",
    "quote": "Brindle Components ended the quarter with $72 million of cash and no long-term debt.",
    "claims": [
      ["72\\\\s+million", "cash", "no long-term debt"],
      ["capital spending", "18\\\\s+million", "second assembly line", "October"]
    ]
  },
  {
    "id": "Q3",
    "citation": "Excerpt C",
    "quote": "Component lead times have fallen from 11 weeks to 7 weeks, which may ease pricing power for suppliers.",
    "claims": [
      ["shipments", "9\\\\s*%", "grid upgrades"],
      ["lead times", "11\\\\s+weeks", "7\\\\s+weeks", "pricing power"]
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
The pilot enrolled 120 households across three neighborhoods.

00:00:15.000 --> 00:00:22.000
During the six-week trial, peak electricity demand fell by 8 percent.

00:00:28.000 --> 00:00:35.000
No battery faults were reported, although two homes lost Wi-Fi briefly.
`;

export const VIDEO_GOLD = `// kq7Vx2Lm9Rt4
[
  {
    "timestamp": "00:07",
    "start": 4,
    "end": 10,
    "claim": "The pilot enrolled 120 households in three neighborhoods.",
    "quote": "The pilot enrolled 120 households across three neighborhoods.",
    "patterns": ["120\\\\s+households", "three\\\\s+neighborhoods"]
  },
  {
    "timestamp": "00:18",
    "start": 15,
    "end": 22,
    "claim": "Peak electricity demand fell 8 percent during the six-week trial.",
    "quote": "During the six-week trial, peak electricity demand fell by 8 percent.",
    "patterns": ["peak electricity demand", "8\\\\s+percent", "six-week trial"]
  },
  {
    "timestamp": "00:31",
    "start": 28,
    "end": 35,
    "claim": "No battery faults were reported, but two homes briefly lost Wi-Fi.",
    "quote": "No battery faults were reported, although two homes lost Wi-Fi briefly.",
    "patterns": ["no battery faults", "two homes", "Wi-Fi"]
  }
]
`;
