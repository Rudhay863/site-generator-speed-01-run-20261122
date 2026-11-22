// Faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Same answers byte for byte; faster by (a) a chunk-based HTML escaper instead of a
// per-character regex replace, (b) a fused lex+render Markdown pass with no token
// objects, (c) a memoised slugify with an ASCII fast path, (d) array-joined template
// output with a scope chain that avoids per-render object spreads, and (e) cards
// computed once per source and reused for page views.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
/** `text` with & < > " and ' escaped, in one regex pass over the whole chunk. */
function escapeHtml(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** JS \s set (White_Space + LineTerminator), by code unit. */
function isWS(c) {
  return (
    c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    let c = text.charCodeAt(i);
    if (c === 32 || c === 10 || c === 9 || c === 13 || c === 11 || c === 12) {
      i++;
      continue;
    }
    if (isWS(c)) {
      i++;
      continue;
    }
    n++;
    i++;
    while (i < len) {
      c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 9 || c === 13 || c === 11 || c === 12 || isWS(c)) break;
      i++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- text: slug, date

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Per-build slug cache (fresh for every case: nothing is carried across cases). */
function makeSlugify() {
  const cache = new Map();
  const NONASCII = /[^\x00-\x7F]/;
  return function slugify(text) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    // NFKD is the identity on pure ASCII, and ASCII has no combining marks.
    const plain = NONASCII.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
    let out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, 64).replace(/-+$/, '');
    const res = out === '' ? 'untitled' : out;
    cache.set(text, res);
    return res;
  };
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * Walks the lines with indexOf instead of splitting the whole source (the body
 * is one slice, not a re-join of every line).
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing line first: with no close, that error wins over any line error.
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let lineNo = 2; // 1-based number of the line starting at pos
  let close = -1;
  let bodyStart = text.length;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (text.slice(pos, end) === '---') {
      close = lineNo;
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = firstNl === -1 ? text.length : firstNl + 1;
  lineNo = 2;
  while (lineNo < close) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    let p = 0;
    while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
    if (p !== line.length && line.charCodeAt(0) !== 35) {
      // key: [a-z_]+, then ':' and either the end or ' ' + value
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
      let vstart;
      if (k + 1 === line.length) vstart = line.length;
      else if (line.charCodeAt(k + 1) === 32) vstart = k + 2;
      else return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, k);
      let vend = line.length;
      while (vend > vstart && (line.charCodeAt(vend - 1) === 32 || line.charCodeAt(vend - 1) === 9)) vend--;
      const raw = line.slice(vstart, vend);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) break;
    pos = nl + 1;
    lineNo++;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A template's free first-segments: the names its lookups read that no `for` of its
 * own binds, plus those of every template it (transitively) includes. `freeOf` holds
 * the current approximation for includes; iterate to a fixed point for cycles.
 */
function freeSetOf(nodes, freeOf) {
  const free = new Set();
  const walk = (ns, bound) => {
    for (const n of ns) {
      if (n.kind === 'var' || n.kind === 'raw') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
      } else if (n.kind === 'if') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
        walk(n.then, bound);
        if (n.else !== null) walk(n.else, bound);
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        walk(n.body, b2);
      } else if (n.kind === 'include') {
        const sub = freeOf.get(n.name);
        if (sub !== undefined) for (const x of sub) if (!bound.has(x)) free.add(x);
      }
    }
  };
  walk(nodes, new Set());
  return free;
}

function renderNodes(nodes, scope, templates, depth, out, bound, constCache, constant, freeOf) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, templates, depth, out, bound, constCache, constant, freeOf);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        bound.push(n.name);
        for (let k = 0; k < xs.length; k++) {
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(n.body, { vars, parent: scope }, templates, depth, out, bound, constCache, constant, freeOf);
        }
        bound.pop();
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t === undefined || depth >= 8) break;
        if (constant.get(n.name) === true) {
          // A constant template reads only site/tags/recent (fixed for the build),
          // so its output at this depth is the same in every scope -- unless a loop
          // on the way here binds one of those names and shadows it.
          const f = freeOf.get(n.name);
          let shadowed = false;
          for (const x of f) {
            if (bound.includes(x)) {
              shadowed = true;
              break;
            }
          }
          if (!shadowed) {
            const key = n.name + ":" + (depth + 1);
            let cached = constCache.get(key);
            if (cached === undefined) {
              const tmp = [];
              renderNodes(t, scope, templates, depth + 1, tmp, bound, constCache, constant, freeOf);
              cached = tmp.join('');
              constCache.set(key, cached);
            }
            out.push(cached);
            break;
          }
        }
        renderNodes(t, scope, templates, depth + 1, out, bound, constCache, constant, freeOf);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- markdown

const CONTINUED = /^ {2,}\S/;
/** Trim spaces and tabs at both ends; returns the line itself when nothing trims. */
function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return s === 0 && e === line.length ? line : line.slice(s, e);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}
function isSpaceTab(c) {
  return c === 32 || c === 9;
}
/** Fence open: language ('' when none) or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  for (let j = i; j < line.length; j++) if (!isSpaceTab(line.charCodeAt(j))) return null;
  return line.slice(3, i);
}
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) if (!isSpaceTab(line.charCodeAt(j))) return false;
  return true;
}
/** { depth, text } or null. */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h === 0 || h > 6) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let e = line.length;
  while (e > h && isSpaceTab(line.charCodeAt(e - 1))) e--;
  let s = h;
  while (s < e && isSpaceTab(line.charCodeAt(s))) s++;
  if (s >= e) return null;
  return { depth: h, text: line.slice(s, e) };
}
function isHr(line) {
  const ok = line.startsWith('---') || line.startsWith('***');
  if (!ok) return false;
  for (let j = 3; j < line.length; j++) if (!isSpaceTab(line.charCodeAt(j))) return false;
  return true;
}
function isBlank(line) {
  for (let j = 0; j < line.length; j++) if (!isSpaceTab(line.charCodeAt(j))) return false;
  return true;
}
/** Bullet item text or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}
/** { start, text } or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/** Whether code unit `c` is one a backslash escapes: \ ` * _ [ ] ( ) # + - . ! > */
function isEscCode(c) {
  return (
    c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 || c === 40 || c === 41 || c === 35 ||
    c === 43 || c === 45 || c === 46 || c === 33 || c === 62
  );
}

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wl = what.length;
  for (let j = from; j <= s.length - wl; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && isEscCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscCode(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. One pass: plain text is
 * flushed in slices and the five HTML specials are escaped as they are met, instead
 * of scanning each plain run a second time through a regex escaper.
 */
function inline(s, env) {
  const out = [];
  const n = s.length;
  let i = 0;
  let last = 0;
  const flush = (to) => {
    if (to > last) out.push(s.slice(last, to));
  };
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < n && isEscCode(s.charCodeAt(i + 1))) {
        flush(i);
        const e = s[i + 1];
        out.push(ESCAPES[e] ?? e);
        i += 2;
        last = i;
      } else {
        i++; // a lone backslash is plain text, flushed with its run
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        flush(i);
        out.push('<code>', escapeHtml(s.slice(i + 1, k)), '</code>');
        i = k + 1;
        last = i;
      } else {
        i++; // a backtick with no closer is plain text
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          flush(i);
          out.push('<strong>', inline(s.slice(i + 2, k), env), '</strong>');
          i = k + 2;
          last = i;
        } else {
          i += 2; // '**' with no closer is plain text, flushed with its run
        }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        flush(i);
        out.push('<em>', inline(s.slice(i + 1, k), env), '</em>');
        i = k + 1;
        last = i;
      } else {
        i++; // a lone star is plain text
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(i + 1, k), env), '</a>');
        i = m + 1;
        last = i;
        continue;
      }
      i++; // a '[' with no link after it is plain text
      continue;
    }
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      flush(i);
      out.push(ESCAPES[s[i]]);
      i++;
      last = i;
      continue;
    }
    i++;
  }
  flush(n);
  return out.join('');
}

/** Rendered Markdown: its HTML, table of contents and excerpt, in one pass over lines. */
function renderMarkdown(src, env, slugify) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence !== null) {
      i++;
      const parts = [];
      while (i < n && !isFenceClose(lines[i])) {
        parts.push(escapeHtml(lines[i]), '\n');
        i++;
      }
      i++;
      blocks.push(`<pre><code${fence === '' ? '' : ` class="language-${escapeHtml(fence)}"`}>${parts.join('')}</code></pre>\n`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const ls = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') ls.push(t);
      }
      blocks.push(ls.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(ls.length === 1 ? ls[0] : ls.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let cur = null;
      while (i < n) {
        let m;
        if (isOrdered) {
          m = orderedOf(lines[i]);
          if (m !== null) {
            cur = [trimLine(m.text)];
            items.push(cur);
            i++;
            continue;
          }
        } else {
          m = bulletOf(lines[i]);
          if (m !== null) {
            cur = [trimLine(m)];
            items.push(cur);
            i++;
            continue;
          }
        }
        if (CONTINUED.test(lines[i])) {
          cur.push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">` : `<${tag}>`;
      const parts = [open, '\n'];
      for (const item of items) parts.push(`<li>${inline(item.length === 1 ? item[0] : item.join('\n'), env)}</li>\n`);
      parts.push(`</${tag}>\n`);
      blocks.push(parts.join(''));
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.length === 1 ? body[0] : body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  const slugify = makeSlugify();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown. Link targets repeat across sources; cache the resolution per
  // (source directory, target) -- bySource/staticPaths/base are fixed per case.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (
          (target.charCodeAt(0) >= 65 && target.charCodeAt(0) <= 90) ||
          (target.charCodeAt(0) >= 97 && target.charCodeAt(0) <= 122)
        ) {
          // possible scheme: letters, digits, +, -, . then ':'
          let j = 1;
          while (j < target.length) {
            const c = target.charCodeAt(j);
            if (c === 58) return target;
            if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46)) break;
            j++;
          }
        }
        if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const ck = `${dir}\u0000${target}`;
        const hit = linkCache.get(ck);
        if (hit !== undefined) {
          if (hit === null) broken.add(`broken-link ${s.path} -> ${target}`);
          return hit === null ? target : hit;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        let out = null;
        if (path !== null && bySource.has(path)) out = `${bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) out = `${base}/${path}${frag}`;
        linkCache.set(ck, out);
        if (out === null) broken.add(`broken-link ${s.path} -> ${target}`);
        return out === null ? target : out;
      },
    };
    const md = renderMarkdown(s.body, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards (once per source) and page views.
  const linkOf = (s) =>
    s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const s of kept) cards.set(s, cardOf(s));
  const pageOf = (s) => ({
    ...cards.get(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  // Layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const topScope = { vars: { site, tags: allTags, recent }, parent: null };
  // Which templates render the same in every scope: their free names are only
  // site/tags/recent, which are fixed for the build. (Fixed point over includes.)
  const freeOf = new Map([...templates.keys()].map((k) => [k, new Set()]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, nodes] of templates) {
      const f = freeSetOf(nodes, freeOf);
      const cur = freeOf.get(name);
      for (const x of f) {
        if (!cur.has(x)) {
          cur.add(x);
          changed = true;
        }
      }
    }
  }
  const constant = new Map();
  for (const [name, f] of freeOf) {
    let ok = true;
    for (const x of f) {
      if (x !== 'site' && x !== 'tags' && x !== 'recent') {
        ok = false;
        break;
      }
    }
    constant.set(name, ok);
  }
  const constCache = new Map();
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    if (constant.get(name) === true) {
      const key = `${name}:0`;
      let cached = constCache.get(key);
      if (cached === undefined) {
        const out = [];
        renderNodes(nodes, { vars, parent: topScope }, templates, 0, out, [], constCache, constant, freeOf);
        cached = out.join('');
        constCache.set(key, cached);
      }
      return cached;
    }
    const out = [];
    renderNodes(nodes, { vars, parent: topScope }, templates, 0, out, [], constCache, constant, freeOf);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const npages = kept.filter((s) => !s.post).length;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
