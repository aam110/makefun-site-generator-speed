// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Written from the makefun-site README spec; answers byte-for-byte the same.
// Design: one split per source shared by front matter + Markdown, single-pass
// streaming Markdown (no token array), run-sliced inline rendering (no
// per-character escape regex), per-case slug cache, templates parsed once
// per case and rendered into a shared parts array.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- text
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
function escapeHtml(s) {
  return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESC[c]) : s;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

function slugifyRaw(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  if (!/[^\x00-\x7F]/.test(plain)) {
    let s = plain.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (s.charCodeAt(0) === 45) s = s.slice(1);
    if (s.charCodeAt(s.length - 1) === 45) s = s.slice(0, -1);
    s = s.slice(0, 64);
    if (s.charCodeAt(s.length - 1) === 45) s = s.replace(/-+$/, '');
    return s === '' ? 'untitled' : s;
  }
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
  return out === '' ? 'untitled' : out;
}
function slugify(text, cache) {
  let s = cache.get(text);
  if (s === undefined) {
    s = slugifyRaw(text);
    cache.set(text, s);
  }
  return s;
}
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

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
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}
// lines: the source split on '\n'. Returns {data, close} or {error}.
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (FM_BLANK.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, close };
}

// ---------------------------------------------------------------- markdown
const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}
// Cheap first-character guards: only a line opening on a space/tab can be
// blank, only one opening on ` # - * can end a paragraph at all.
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return BLANK.test(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}
function isBlankLine(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  return (c === 32 || c === 9) && BLANK.test(line);
}

// backslash-escapable character codes: \ ` * _ [ ] ( ) # + - . ! >
function isEscapable(code) {
  return code === 92 || code === 96 || code === 42 || code === 95 || code === 91 || code === 93 || code === 40 || code === 41 || code === 35 || code === 43 || code === 45 || code === 46 || code === 33 || code === 62;
}
// The first index from `from` where `s` holds `what` outside a backslash
// escape, or -1. A left-to-right escape scan escapes a character exactly
// when an odd run of backslashes stands right before it, so indexOf jumps
// plus a parity check on that run give the same answer as scanning.
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let k = j - 1;
    let bs = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      bs++;
      k--;
    }
    if (bs % 2 === 1) {
      j = s.indexOf(what, j + 1);
      continue;
    }
    return j;
  }
  return -1;
}
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let k = j - 1;
    let bs = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      bs++;
      k--;
    }
    if (bs % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

// Inline rendering: jump from one special character to the next with a
// single regex scan (C++) instead of walking every character in JS. Plain
// runs are sliced in bulk; `link` resolves a link target to its href. The
// regex is shared and /g, so its lastIndex is reset at the top of every
// loop pass (inline recurses into strong/em/link text, which reuses it).
const SPECIAL_RE = /[\\`*\[&<>"']/g;
function inline(s, link) {
  let out = '';
  const n = s.length;
  let start = 0;
  let scan = 0;
  while (scan < n) {
    SPECIAL_RE.lastIndex = scan;
    const m = SPECIAL_RE.exec(s);
    if (m === null) break;
    const j = m.index;
    const code = s.charCodeAt(j);
    if (code === 92) {
      if (j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
        out += s.slice(start, j) + (ESC[s[j + 1]] ?? s[j + 1]);
        scan = j + 2;
        start = scan;
      } else {
        scan = j + 1; // a backslash before a non-escapable char stays literal
      }
      continue;
    }
    if (code === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += s.slice(start, j) + '<code>' + escapeHtml(s.slice(j + 1, k)) + '</code>';
        scan = k + 1;
        start = scan;
      } else {
        scan = j + 1;
      }
      continue;
    }
    if (code === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          const sv = SPECIAL_RE.lastIndex;
          out += s.slice(start, j) + '<strong>' + inline(s.slice(j + 2, k), link) + '</strong>';
          SPECIAL_RE.lastIndex = sv;
          scan = k + 2;
          start = scan;
        } else {
          out += s.slice(start, j) + '**';
          scan = j + 2;
          start = scan;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        const sv = SPECIAL_RE.lastIndex;
        out += s.slice(start, j) + '<em>' + inline(s.slice(j + 1, k), link) + '</em>';
        SPECIAL_RE.lastIndex = sv;
        scan = k + 1;
        start = scan;
      } else {
        scan = j + 1;
      }
      continue;
    }
    if (code === 91) {
      const k = findUnescaped(s, ']', j + 1);
      const m2 = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (target !== '' && !/\s/.test(target)) {
        const sv = SPECIAL_RE.lastIndex;
        out += s.slice(start, j) + '<a href="' + escapeHtml(link(target)) + '">' + inline(s.slice(j + 1, k), link) + '</a>';
        SPECIAL_RE.lastIndex = sv;
        scan = m2 + 1;
        start = scan;
      } else {
        scan = j + 1;
      }
      continue;
    }
    out += s.slice(start, j) + ESC[s[j]];
    scan = j + 1;
    start = scan;
  }
  if (n > start) out += s.slice(start, n);
  return out;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
function makeLink(dir, bySource, staticPaths, broken, srcPath, base) {
  return (target) => {
    if (SCHEME.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
    const hash = target.indexOf('#');
    const rel = hash === -1 ? target : target.slice(0, hash);
    const frag = hash === -1 ? '' : target.slice(hash);
    const path = rel === '' ? null : resolvePath(dir, rel);
    if (path !== null) {
      const pg = bySource.get(path);
      if (pg !== undefined) return `${pg.url}${frag}`;
      if (staticPaths.has(path)) return `${base}/${path}${frag}`;
    }
    broken.add(`broken-link ${srcPath} -> ${target}`);
    return target;
  };
}

// Streaming Markdown: lines[start..] rendered block by block, no token array.
// Also counts the body's words (runs of non-whitespace; a word cannot span
// a line, since the lines join with '\n'), so no body string is ever built.
function renderMarkdown(lines, start, link, slugCache) {
  let out = '';
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let wordCount = 0;
  for (let k = start; k < lines.length; k++) {
    const ln = lines[k];
    let inW = false;
    for (let q = 0; q < ln.length; q++) {
      const c = ln.charCodeAt(q);
      const ws = c <= 32 ? c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 : c >= 160 && (c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff);
      if (ws) inW = false;
      else if (!inW) {
        inW = true;
        wordCount++;
      }
    }
  }
  let i = start;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    const fence = c0 === 96 && line.startsWith('```') ? FENCE_OPEN.exec(line) : null;
    if (fence !== null) {
      const lang = fence[1];
      const parts = ['<pre><code'];
      if (lang !== '') parts.push(' class="language-', escapeHtml(lang), '"');
      parts.push('>');
      i++;
      while (i < L && !(lines[i].startsWith('```') && FENCE_CLOSE.test(lines[i]))) {
        parts.push(escapeHtml(lines[i]), '\n');
        i++;
      }
      i++;
      parts.push('</code></pre>');
      out += parts.join('') + '\n';
      continue;
    }
    const hd = c0 === 35 ? headingOf(line) : null;
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text, slugCache), ids);
      const html = inline(hd.text, link);
      out += `<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`;
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && HR.test(line)) {
      out += '<hr>\n';
      i++;
      continue;
    }
    if (c0 === 62) {
      const kept = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        const trimmed = trimST(t);
        if (trimmed !== '') kept.push(trimmed);
        i++;
      }
      out += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>\n`;
      continue;
    }
    const bullet = (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32 ? BULLET.exec(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const startNum = isOrdered ? Number(ordered[1]) : 1;
      const items = [];
      while (i < L) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimST(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimST(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      const parts = [open, '\n'];
      for (let k = 0; k < items.length; k++) parts.push('<li>', inline(items[k].join('\n'), link), '</li>\n');
      parts.push(`</${tag}>`);
      out += parts.join('') + '\n';
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < L && !endsParagraph(lines[i])) body.push(trimST(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out += `<p>${html}</p>\n`;
  }
  return { html: out, toc, excerpt: excerpt ?? '', wordCount };
}

// ---------------------------------------------------------------- templates
const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
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
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
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
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}
// Expand {% include %} statically, depth-capped exactly like the runtime
// rule (an include at depth 8 renders nothing). Includes render in the same
// scope, so inlining them into the including template's node list is exact;
// for/if bodies keep their own (copied) node lists. Missing templates expand
// to nothing. Called once per case, after every template has parsed.
function expandIncludes(nodes, templates, depth) {
  const out = [];
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    if (n.kind === 'include') {
      if (depth < 8) {
        const t = templates.get(n.name);
        if (t !== undefined) out.push(...expandIncludes(t, templates, depth + 1));
      }
    } else if (n.kind === 'for') out.push({ kind: 'for', name: n.name, path: n.path, body: expandIncludes(n.body, templates, depth) });
    else if (n.kind === 'if') out.push({ kind: 'if', not: n.not, path: n.path, then: expandIncludes(n.then, templates, depth), else: n.else === null ? null : expandIncludes(n.else, templates, depth) });
    else out.push(n);
  }
  return out;
}
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) s += ', ';
      s += textOf(v[k]);
    }
    return s;
  }
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}
function renderNodes(nodes, scope, parts) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        parts.push(n.text);
        break;
      case 'var':
        parts.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        parts.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, parts);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
          renderNodes(n.body, { vars, parent: scope }, parts);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const slugCache = new Map();
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const expanded = new Map();
  for (const [name, nodes] of templates) expanded.set(name, expandIncludes(nodes, templates, 0));

  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, lines: (f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n')).split('\n') });
    else statics.push(f);
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.close + 1;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
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

  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = dir === '' ? new Set(['posts', 'tags', 'page']) : new Set();
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const link = makeLink(dirOf(s.path), bySource, staticPaths, broken, s.path, base);
    const md = renderMarkdown(s.lines, s.bodyStart, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.wordCount = md.wordCount;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let k = 0; k < tags.length; k++) {
      const slug = slugify(tags[k], slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(tags[k]);
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
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
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.wordCount / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => {
    const c = s.post ? cards.get(s) : cardOf(s);
    return {
      ...c,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  // One top-level scope object, reused across renders: each render sets its
  // own keys and clears them afterwards, so no stale key can leak into the
  // next render (a cleared key reads as undefined, exactly like a missing one).
  const topVars = { site, tags: allTags, recent };
  const topScope = { vars: topVars, parent: null };
  const render = (name, vars) => {
    const nodes = expanded.get(name);
    if (nodes === undefined) return null;
    const keys = Object.keys(vars);
    for (let k = 0; k < keys.length; k++) topVars[keys[k]] = vars[keys[k]];
    const parts = [];
    renderNodes(nodes, topScope, parts);
    for (let k = 0; k < keys.length; k++) topVars[keys[k]] = undefined;
    return parts.join('');
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
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of kept) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
