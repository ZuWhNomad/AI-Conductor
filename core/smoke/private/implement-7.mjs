// Private grader material for implement-7: the reference parser, the visible and hidden tests (they share a harness)
// and the mutants/variants that prove the grader (see test/smoke). Every reference, hidden and mutant body carries the
// canary line.
import { RNG, marked } from './common.mjs';

export const MULTIPART = `// kq7Vx2Lm9Rt4
// Streaming multipart parser (RFC 2046 framing). Feed any chunking with write(); finish with end().
// Body bytes are delivered as they arrive: while a delimiter may be starting, at most delimiter.length - 1 bytes wait.
const CRLF = Buffer.from('\\r\\n');

export class MultipartParser {
  constructor(boundary, handlers = {}) {
    this.delim = Buffer.from('\\r\\n--' + boundary);
    this.h = handlers; this.buf = Buffer.alloc(0); this.consumed = 0; this.state = 'preamble';
  }
  write(chunk) {
    if (this.state === 'done') return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    this.#drain();
  }
  end() { if (this.state !== 'done') throw new Error('truncated multipart body: no close delimiter'); }
  #take(n) { this.buf = this.buf.subarray(n); this.consumed += n; }
  #drain() {
    for (;;) {
      const b = this.buf;
      if (this.state === 'preamble') {
        const bare = this.delim.subarray(2); // the first delimiter may open the stream without its CRLF
        if (this.consumed === 0) {
          const head = b.subarray(0, bare.length);
          if (head.length < bare.length) { if (bare.subarray(0, head.length).equals(head)) return; }
          else if (head.equals(bare)) { this.#take(bare.length); this.state = 'delim'; continue; }
        }
        const i = b.indexOf(this.delim);
        if (i >= 0) { this.#take(i + this.delim.length); this.state = 'delim'; continue; }
        this.#take(Math.max(0, b.length - (this.delim.length - 1))); return;
      }
      if (this.state === 'delim') {
        if (b.length < 2) return;
        if (b[0] === 0x2d && b[1] === 0x2d) { this.state = 'done'; this.buf = Buffer.alloc(0); this.h.onEnd?.(); return; }
        const i = b.indexOf(CRLF); // transport padding, then CRLF
        if (i < 0) return;
        this.#take(i + 2); this.state = 'headers'; continue;
      }
      if (this.state === 'headers') {
        if (b.length >= 2 && b[0] === 13 && b[1] === 10) { this.#take(2); this.state = 'body'; this.h.onPart?.({}); continue; }
        const i = b.indexOf('\\r\\n\\r\\n');
        if (i < 0) return;
        const headers = {};
        for (const line of b.subarray(0, i).toString('latin1').split('\\r\\n')) { const c = line.indexOf(':'); if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim(); }
        this.#take(i + 4); this.state = 'body'; this.h.onPart?.(headers); continue;
      }
      if (this.state === 'body') {
        const i = b.indexOf(this.delim);
        if (i >= 0) { if (i > 0) this.h.onData?.(b.subarray(0, i)); this.#take(i + this.delim.length); this.h.onPartEnd?.(); this.state = 'delim'; continue; }
        const keep = this.delim.length - 1;
        if (b.length > keep) { this.h.onData?.(b.subarray(0, b.length - keep)); this.#take(b.length - keep); }
        return;
      }
    }
  }
}
`;

// A genuinely different design: one byte at a time through a KMP automaton for the delimiter; the bytes held back are
// exactly the matched delimiter prefix. Used only to prove the hidden tests accept other correct designs.
export const MULTIPART_KMP = `// kq7Vx2Lm9Rt4
export class MultipartParser {
  constructor(boundary, handlers = {}) {
    this.h = handlers; const pat = this.pat = Buffer.from('\\r\\n--' + boundary);
    const fail = this.fail = new Int32Array(pat.length);
    for (let i = 1, k = 0; i < pat.length; i++) { while (k && pat[i] !== pat[k]) k = fail[k - 1]; if (pat[i] === pat[k]) k++; fail[i] = k; }
    this.state = 'preamble'; this.k = 2; // as if a CRLF preceded the stream: a bare first delimiter opens it
    this.held = Buffer.alloc(0); this.line = []; this.headers = {}; this.dashes = 0;
  }
  write(chunk) {
    if (this.state === 'done') return;
    chunk = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    let from = 0;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (this.state === 'preamble' || this.state === 'body') {
        let k = this.k;
        while (k && c !== this.pat[k]) k = this.fail[k - 1];
        if (c === this.pat[k]) k++;
        this.k = k;
        if (k === this.pat.length) {
          if (this.state === 'body') { this.#emit(chunk, from, i + 1, this.pat.length); this.h.onPartEnd?.(); }
          this.held = Buffer.alloc(0); from = i + 1; this.k = 0; this.state = 'afterDelim'; this.dashes = 0;
        }
      } else if (this.state === 'afterDelim') {
        if (this.dashes === 1) { if (c !== 0x2d) throw new Error('bad delimiter tail'); this.state = 'done'; this.h.onEnd?.(); return; }
        if (c === 0x2d) this.dashes = 1;
        else if (c === 13) this.state = 'afterDelimCR';
        else if (c !== 0x20 && c !== 0x09) throw new Error('bad delimiter tail');
      } else if (this.state === 'afterDelimCR') {
        if (c !== 10) throw new Error('bad delimiter tail');
        this.state = 'headers'; this.line = []; this.headers = {};
      } else if (this.state === 'headers') {
        this.line.push(c);
        const n = this.line.length;
        if (n >= 2 && this.line[n - 2] === 13 && this.line[n - 1] === 10) {
          const text = Buffer.from(this.line.slice(0, n - 2)).toString('latin1');
          this.line = [];
          if (text === '') { this.state = 'body'; this.k = 0; this.held = Buffer.alloc(0); from = i + 1; this.h.onPart?.(this.headers); }
          else { const j = text.indexOf(':'); if (j > 0) this.headers[text.slice(0, j).trim().toLowerCase()] = text.slice(j + 1).trim(); }
        }
      }
    }
    if (this.state === 'body') this.#emit(chunk, from, chunk.length, this.k);
  }
  end() { if (this.state !== 'done') throw new Error('truncated multipart body: no close delimiter'); }
  // The bytes not yet delivered are held ++ chunk[from, to); deliver all but the last \`keep\` of them.
  #emit(chunk, from, to, keep) {
    const part = chunk.subarray(from, to);
    const emitLen = this.held.length + part.length - keep;
    if (emitLen <= 0) { this.held = Buffer.concat([this.held, part]); return; }
    if (emitLen <= this.held.length) { this.h.onData?.(this.held.subarray(0, emitLen)); this.held = Buffer.concat([this.held.subarray(emitLen), part]); return; }
    if (this.held.length) this.h.onData?.(this.held);
    const fromPart = emitLen - this.held.length;
    if (fromPart) this.h.onData?.(part.subarray(0, fromPart));
    this.held = Buffer.from(part.subarray(fromPart));
  }
}
`;

const HARNESS = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MultipartParser } from './multipart.mjs';

const B = 'xYz--boundary_42';
// Build a well-formed body. parts: [{ headers?, body }]. The first delimiter is bare unless there is a preamble.
function build(parts, { preamble = '', epilogue = '', padding = '' } = {}) {
  const out = [];
  if (preamble) out.push(Buffer.from(preamble));
  parts.forEach((p, i) => {
    out.push(Buffer.from((i === 0 && !preamble ? '' : '\\r\\n') + '--' + B + padding + '\\r\\n'));
    for (const [k, v] of Object.entries(p.headers || {})) out.push(Buffer.from(k + ': ' + v + '\\r\\n'));
    out.push(Buffer.from('\\r\\n'), Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body));
  });
  out.push(Buffer.from((parts.length || preamble ? '\\r\\n' : '') + '--' + B + '--' + epilogue));
  return Buffer.concat(out);
}
// Collect events; the order of events is checked as they arrive.
function collect() {
  const parts = []; let cur = null, ended = 0;
  const parser = new MultipartParser(B, {
    onPart(headers) { if (cur) throw new Error('onPart before onPartEnd'); cur = { headers, chunks: [] }; },
    onData(buf) { if (!cur) throw new Error('onData outside a part'); cur.chunks.push(Buffer.from(buf)); },
    onPartEnd() { if (!cur) throw new Error('onPartEnd outside a part'); parts.push({ headers: cur.headers, body: Buffer.concat(cur.chunks) }); cur = null; },
    onEnd() { if (cur) throw new Error('onEnd inside a part'); ended++; },
  });
  return { parser, parts, get ended() { return ended; } };
}
function feed(parser, body, chunker) { for (const c of chunker(body)) parser.write(c); parser.end(); }
const every = (n) => (body) => { const out = []; for (let i = 0; i < body.length; i += n) out.push(body.subarray(i, i + n)); return out; };
`;

export const MULTIPART_TEST = `${HARNESS}
test('two parts with headers, written in one piece', () => {
  const c = collect();
  feed(c.parser, build([{ headers: { 'Content-Disposition': 'form-data; name="a"' }, body: 'hello' }, { headers: { 'Content-Type': 'text/plain' }, body: 'world\\r\\n' }]), every(1 << 20));
  assert.equal(c.parts.length, 2); assert.equal(c.ended, 1);
  assert.deepEqual(c.parts[0].headers, { 'content-disposition': 'form-data; name="a"' }); assert.equal(c.parts[0].body.toString(), 'hello');
  assert.deepEqual(c.parts[1].headers, { 'content-type': 'text/plain' }); assert.equal(c.parts[1].body.toString(), 'world\\r\\n');
});
test('the same body one byte at a time gives the same parts', () => {
  const body = build([{ body: 'first' }, { headers: { 'X-A': '1' }, body: '' }, { body: Buffer.from([0, 13, 10, 45, 45, 255]) }]);
  const whole = collect(); feed(whole.parser, body, every(1 << 20));
  const bytes = collect(); feed(bytes.parser, body, every(1));
  assert.deepEqual(bytes.parts.map((p) => [p.headers, [...p.body]]), whole.parts.map((p) => [p.headers, [...p.body]]));
  assert.equal(bytes.parts.length, 3); assert.equal(bytes.ended, 1);
});
test('a body may contain the start of a delimiter', () => {
  const c = collect(); const tricky = 'a\\r\\n--' + B.slice(0, 6) + 'nope\\r\\n--\\r\\n-\\r';
  feed(c.parser, build([{ body: tricky }]), every(3));
  assert.equal(c.parts[0].body.toString(), tricky);
});
test('end() before the close delimiter throws', () => {
  const c = collect(); const body = build([{ body: 'abc' }]);
  c.parser.write(body.subarray(0, body.length - 4));
  assert.throws(() => c.parser.end(), /truncated/);
});
test('body bytes are delivered before the part ends', () => {
  const big = Buffer.alloc(50000, 0x61); const body = build([{ body: big }]);
  let delivered = 0; const parser = new MultipartParser(B, { onData: (buf) => { delivered += buf.length; } });
  parser.write(body.subarray(0, 40000));
  assert.ok(delivered >= 40000 - (body.length - big.length) - (B.length + 8), 'delivered ' + delivered);
});
`;

export const MULTIPART_HIDDEN = `// kq7Vx2Lm9Rt4
${HARNESS}${RNG}
// Whole-buffer reference: simple enough to trust.
function reference(body) {
  const delim = Buffer.from('\\r\\n--' + B);
  const full = Buffer.concat([Buffer.from('\\r\\n'), body]);
  const parts = []; let pos = full.indexOf(delim);
  if (pos < 0) throw new Error('truncated');
  pos += delim.length;
  for (;;) {
    if (full[pos] === 0x2d && full[pos + 1] === 0x2d) return parts;
    let p = full.indexOf('\\r\\n', pos) + 2; const headers = {};
    if (full[p] === 13 && full[p + 1] === 10) p += 2;
    else { const e = full.indexOf('\\r\\n\\r\\n', p); for (const line of full.subarray(p, e).toString('latin1').split('\\r\\n')) { const i = line.indexOf(':'); headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); } p = e + 4; }
    const next = full.indexOf(delim, p); if (next < 0) throw new Error('truncated');
    parts.push({ headers, body: full.subarray(p, next) }); pos = next + delim.length;
  }
}
const seeded = (seed, max) => (body) => { const rand = rng(seed); const out = []; for (let i = 0; i < body.length;) { const n = 1 + Math.floor(rand() * max); out.push(body.subarray(i, i + n)); i += n; } return out; };
const bytes = (n, seed) => { const rand = rng(seed); return Buffer.from(Array.from({ length: n }, () => Math.floor(rand() * 256))); };
const planted = (n, seed) => { const b = bytes(n, seed); const marks = ['\\r\\n--' + B.slice(0, 9), '\\r\\n--', '\\r\\n', '--' + B, '\\r']; const rand = rng(seed + 1); for (let i = 0; i < 40; i++) { const m = Buffer.from(marks[i % marks.length]); m.copy(b, Math.floor(rand() * (n - m.length))); } return b; };

test('body bytes are delivered as they arrive (at most boundary.length + 8 held back)', () => {
  const big = planted(200000, 5); const body = build([{ headers: { 'X-Big': '1' }, body: big }]);
  const bodyStart = body.length - big.length - ('\\r\\n--' + B + '--').length;
  let delivered = 0; const parser = new MultipartParser(B, { onData: (buf) => { delivered += buf.length; } });
  for (let i = 0; i < body.length; i += 4096) {
    parser.write(body.subarray(i, i + 4096));
    const written = Math.min(Math.max(0, i + 4096 - bodyStart), big.length);
    assert.ok(delivered >= written - (B.length + 8), 'after ' + (i + 4096) + ' bytes: delivered ' + delivered + ' of ' + written);
  }
  parser.end(); assert.equal(delivered, big.length);
});
test('truncated streams throw on end(), complete ones do not', () => {
  const body = build([{ body: 'abc' }, { body: 'def' }]);
  for (const cut of [1, 5, body.length - 1, body.length - 2, body.length - 10]) {
    const c = collect(); c.parser.write(body.subarray(0, cut));
    assert.throws(() => c.parser.end(), /truncated/, 'cut at ' + cut);
  }
  const c = collect(); feed(c.parser, body, every(5)); assert.equal(c.ended, 1); assert.doesNotThrow(() => c.parser.end());
});
test('bytes after the close delimiter are ignored', () => {
  const c = collect(); const body = Buffer.concat([build([{ body: 'x' }]), Buffer.from('\\r\\n--' + B + '\\r\\n\\r\\nghost')]);
  feed(c.parser, body, every(3));
  assert.equal(c.parts.length, 1); assert.equal(c.ended, 1);
});

const BODIES = {
  'two text parts': build([{ headers: { 'Content-Disposition': 'form-data; name="a"' }, body: 'hello' }, { headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'world\\r\\n' }]),
  'empty part, no headers': build([{ body: '' }, { headers: { 'X-One': 'x' }, body: '' }, { body: 'z' }]),
  'near delimiters inside a body': build([{ body: 'a\\r\\n--' + B.slice(0, 8) + '!\\r\\n--\\r\\n-\\r\\r\\n\\n--' + B + 'x' }]),
  'a body that is a delimiter prefix repeated': build([{ body: ('\\r\\n--' + B.slice(0, 5)).repeat(30) + '\\r\\n\\r\\n--' }]),
  'bodies ending in a delimiter prefix, right before the real delimiter': build([{ body: 'p\\r\\n--' + B.slice(0, 4) }, { body: 'q\\r' }, { body: 'r\\r\\n-' }, { body: '\\r\\n' }]),
  'all byte values, body ending in CRLF': build([{ body: Buffer.concat([bytes(1024, 3), Buffer.from('\\r\\n')]) }, { body: Buffer.from('\\r\\n\\r\\n') }]),
  'preamble, epilogue and transport padding': build([{ body: 'p1' }, { body: 'p2' }], { preamble: 'This is the preamble.\\r\\n--not-it\\r\\n', epilogue: '\\r\\nepilogue\\r\\n--' + B + '\\r\\n', padding: ' \\t' }),
  'a preamble that starts like the boundary': build([{ body: 'p' }], { preamble: '--' + B.slice(0, 7) + 'X preamble' }),
  'no parts at all': build([]),
  'header names lowercased, values with colons and spaces': build([{ headers: { 'Content-Disposition': 'form-data; name="a:b"; filename="x:y.txt"', 'X-Trim': '   spaced   ' }, body: 'v' }]),
  'a large binary part with planted near-delimiters': build([{ headers: { 'Content-Type': 'application/octet-stream' }, body: planted(300000, 11) }, { body: 'tail' }]),
};
const CHUNKERS = { whole: every(1 << 22), 'one byte': every(1), 'two bytes': every(2), 'seven bytes': every(7), '4096 bytes': every(4096), ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((s) => ['seeded ' + s, seeded(s, 40)])) };
const same = (parts, want) => parts.length === want.length && parts.every((p, i) => JSON.stringify(p.headers) === JSON.stringify(want[i].headers) && p.body.equals(want[i].body));

test('every body gives the reference parts under every chunking', () => {
  for (const [name, body] of Object.entries(BODIES)) {
    const want = reference(body);
    for (const [cname, chunker] of Object.entries(CHUNKERS)) {
      if (body.length > 100000 && (cname === 'one byte' || cname === 'two bytes')) continue;
      const c = collect(); feed(c.parser, body, chunker);
      assert.ok(same(c.parts, want), name + ' / ' + cname + ': parts differ (' + c.parts.length + ' vs ' + want.length + ')');
      assert.equal(c.ended, 1, name + ' / ' + cname + ': onEnd calls');
    }
  }
});
`;

// Mutants and variants are { path: body } maps; write them with bare() so the canary does not decide the verdict.
const as = (files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, marked(v)]));
export const MUTANTS = {
  'no hold-back: emits every byte that is not a complete delimiter': as({ 'src/multipart.mjs': MULTIPART.replace('const keep = this.delim.length - 1;', 'const keep = 0;') }),
  'the CRLF before a delimiter is treated as body': as({ 'src/multipart.mjs': MULTIPART.replace("this.delim = Buffer.from('\\r\\n--' + boundary);", "this.delim = Buffer.from('--' + boundary);").replace('const bare = this.delim.subarray(2);', 'const bare = this.delim;') }),
  'the first delimiter must be preceded by CRLF': as({ 'src/multipart.mjs': MULTIPART.replace('if (this.consumed === 0) {', 'if (false) {') }),
  'headers not lowercased': as({ 'src/multipart.mjs': MULTIPART.replace('.trim().toLowerCase()]', '.trim()]') }),
  // With a CR-free boundary the KMP table is all zeros, so "restart at the current byte" is correct; the classic bug is
  // to drop the mismatching byte, which misses a delimiter that starts right after a partial one.
  'naive byte matcher: a mismatch resets the match and skips the mismatching byte': as({ 'src/multipart.mjs': MULTIPART_KMP.replace('while (k && c !== this.pat[k]) k = this.fail[k - 1];\n        if (c === this.pat[k]) k++;', 'if (k && c !== this.pat[k]) k = 0; else if (c === this.pat[k]) k++;') }),
  'headers parsed as utf8 and bodies passed through String (binary damage)': as({ 'src/multipart.mjs': MULTIPART.replace("if (i > 0) this.h.onData?.(b.subarray(0, i));", "if (i > 0) this.h.onData?.(Buffer.from(b.subarray(0, i).toString()));").replace("this.h.onData?.(b.subarray(0, b.length - keep));", "this.h.onData?.(Buffer.from(b.subarray(0, b.length - keep).toString()));") }),
};

// Hits the 60 s test timeout (quadratic concatenation), so the tests run it only with CONDUCTOR_SMOKE_SLOW=1.
export const SLOW_MUTANTS = {
  'buffers the whole stream and parses on end()': as({ 'src/multipart.mjs': MULTIPART
    .replace("  write(chunk) {\n    if (this.state === 'done') return;\n    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);\n    this.#drain();\n  }\n  end() { if (this.state !== 'done') throw new Error('truncated multipart body: no close delimiter'); }",
      "  write(chunk) { this.all = Buffer.concat([this.all || Buffer.alloc(0), chunk]); }\n  end() { this.buf = this.all || Buffer.alloc(0); this.#drain(); if (this.state !== 'done') throw new Error('truncated multipart body: no close delimiter'); }") }),
};

export const VARIANTS = {
  'byte-at-a-time KMP automaton instead of Buffer.indexOf': as({ 'src/multipart.mjs': MULTIPART_KMP }),
  'holds back a full delimiter length plus CRLF (within the +8 slack)': as({ 'src/multipart.mjs': MULTIPART.replace('const keep = this.delim.length - 1;', 'const keep = this.delim.length + 2;') }),
};
