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
