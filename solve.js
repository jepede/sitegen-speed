// An independent implementation of makefun-site's format.  Templates are
// compiled to JavaScript and Markdown copies ordinary text in whole spans.

import { setFlagsFromString } from 'node:v8';
// These builds finish before optimizing large generated functions pays back
// its compilation cost. A larger nursery also avoids collecting their strings
// while the output tree is still being assembled.
setFlagsFromString('--no-opt --max-semi-space-size=64');

const own = Object.hasOwn;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const entities = { __proto__: null, '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const entity = c => entities[c];
const escape = s => s.replace(/[&<>"']/g, entity);
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = s => `${Number(s.slice(8))} ${months[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;

function slug(s) {
  const plain = /[^\x00-\x7f]/.test(s) ? s.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[A-Z]/g, c => c.toLowerCase()) : s.toLowerCase();
  return plain
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-+$/, '') || 'untitled';
}

function unique(s, taken) {
  let v = s;
  for (let n = 2; taken.has(v); ++n) v = s + '-' + n;
  taken.add(v);
  return v;
}

// Front matter is scanned separately from the body.  In particular, finding
// the closing delimiter precedes validating any of the intervening lines.
function front(text) {
  if (text !== '---' && !text.startsWith('---\n')) return 'no front matter';
  let close = -1, end = 0, p = 4;
  while (p <= text.length) {
    let q = text.indexOf('\n', p);
    if (q < 0) q = text.length;
    if (text.slice(p, q) === '---') { close = p; end = q; break; }
    if (q === text.length) break;
    p = q + 1;
  }
  if (close < 0) return 'the front matter is not closed';
  const data = {};
  p = 4;
  let lineNo = 2;
  while (p < close) {
    const q = text.indexOf('\n', p);
    const line = text.slice(p, q);
    p = q + 1;
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) { ++lineNo; continue; }
    const m = /^([a-z_]+):(?: (.*))?$/.exec(line);
    if (m === null) return `line ${lineNo} is not "key: value"`;
    ++lineNo;
    const key = m[1], raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (key !== 'title' && key !== 'date' && key !== 'tags' && key !== 'draft' && key !== 'layout' && key !== 'slug' && key !== 'summary') return `unknown key "${key}"`;
    if (own(data, key)) return `key "${key}" is given twice`;
    if (raw === '') return `key "${key}" has no value`;
    let value;
    if (key === 'title' || key === 'summary') {
      if (raw[0] === '"') {
        if (raw.length < 2 || raw[raw.length - 1] !== '"') return `key "${key}": a quoted string is not closed`;
        value = '';
        for (let i = 1; i < raw.length - 1; ++i) {
          const c = raw[i];
          if (c === '\\') {
            const next = raw[i + 1];
            if ((next !== '"' && next !== '\\') || i + 1 === raw.length - 1) return `key "${key}": a quoted string holds an escape other than \\" or \\\\`;
            value += next;
            ++i;
          } else if (c === '"') return `key "${key}": a quoted string holds a stray quote`;
          else value += c;
        }
      } else {
        if (raw[0] === '[') return `key "${key}": a bare string opens on [`;
        value = raw;
      }
    } else if (key === 'date') {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
      const y = m ? +m[1] : 0, mo = m ? +m[2] : 0, d = m ? +m[3] : 0;
      const days = mo === 2 ? (y % 4 === 0 && y % 100 !== 0 || y % 400 === 0 ? 29 : 28) : (mo === 4 || mo === 6 || mo === 9 || mo === 11 ? 30 : 31);
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > days) return 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
      value = raw;
    } else if (key === 'tags') {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return 'key "tags": not a list [a, b]';
      const inner = raw.slice(1, -1);
      value = inner.trim() === '' ? [] : inner.split(',').map(s => s.trim());
      for (const t of value) if (t === '' || !/^[^"[\]]+$/.test(t)) return 'key "tags": an empty tag, or one holding " [ or ]';
    } else if (key === 'draft') {
      if (raw !== 'true' && raw !== 'false') return 'key "draft": true or false';
      value = raw === 'true';
    } else if (key === 'layout') {
      if (!/^[a-z0-9-]+$/.test(raw)) return 'key "layout": not a template name';
      value = raw;
    } else {
      if (raw.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) return 'key "slug": not a slug';
      value = raw;
    }
    data[key] = value;
  }
  return own(data, 'title') ? { data, body: end === text.length ? '' : text.slice(end + 1) } : 'no title';
}

// Compact template nodes: text, escaped/raw value, loop, conditional, include.
class TemplateSyntaxError extends Error {}
function parseTemplate(name, src) {
  const fail = why => { throw new TemplateSyntaxError(`template "${name}": ${why}`); };
  function path(s) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(s)) fail(`${JSON.stringify(s)} is not a path`);
    return s.split('.');
  }
  const tokens = [];
  let p = 0, pending = '';
  while (p < src.length) {
    const a = src.indexOf('{', p);
    if (a < 0 || a === src.length - 1) { pending += src.slice(p); break; }
    const c = src[a + 1];
    if (c !== '{' && c !== '%') { pending += src.slice(p, a + 1); p = a + 1; continue; }
    pending += src.slice(p, a);
    if (c === '{') {
      const raw = src[a + 2] === '{', width = raw ? 3 : 2;
      const b = src.indexOf(raw ? '}}}' : '}}', a + width);
      if (b < 0) fail(`a ${raw ? '{{{' : '{{'} is not closed`);
      if (pending) tokens.push([0, pending]);
      pending = '';
      tokens.push([raw ? 2 : 1, path(src.slice(a + width, b).trim())]);
      p = b + width;
    } else {
      const b = src.indexOf('%}', a + 2);
      if (b < 0) fail('a {% is not closed');
      const end = b + 2, start = src.lastIndexOf('\n', a - 1) + 1;
      let next = src.indexOf('\n', end);
      const lineEnd = next < 0 ? src.length : next;
      const alone = /^[ \t]*$/.test(src.slice(start, a)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
      if (alone) pending = pending.slice(0, pending.length - (a - start));
      if (pending) tokens.push([0, pending]);
      pending = '';
      tokens.push([6, src.slice(a + 2, b).trim()]);
      p = alone ? (next < 0 ? src.length : next + 1) : end;
    }
  }
  if (pending) tokens.push([0, pending]);
  const root = [7, []], stack = [root];
  let body = root[1];
  for (const tok of tokens) {
    if (tok[0] !== 6) { body.push(tok); continue; }
    const tag = tok[1], top = stack[stack.length - 1];
    let m;
    if ((m = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/.exec(tag))) {
      const node = [3, m[1], path(m[2]), []];
      body.push(node); stack.push(node); body = node[3];
    } else if ((m = /^if (not )?(\S+)$/.exec(tag))) {
      const node = [4, !!m[1], path(m[2]), [], null];
      body.push(node); stack.push(node); body = node[3];
    } else if (tag === 'else') {
      if (top[0] !== 4 || top[4] !== null) fail('an else outside an if');
      top[4] = []; body = top[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top[0] !== (tag === 'endfor' ? 3 : 4)) fail(`an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent[0] === 7 ? parent[1] : parent[0] === 3 ? parent[3] : parent[4] ?? parent[3];
    } else if ((m = /^include "([a-z0-9-]+)"$/.exec(tag))) body.push([5, m[1]]);
    else fail(`{% ${tag} %} is not a tag`);
  }
  if (stack.length !== 1) fail(`a ${stack[stack.length - 1][0] === 3 ? 'for' : 'if'} is not closed`);
  return root[1];
}

function asText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return Array.isArray(v) ? v.map(asText).join(', ') : '';
}
const truth = v => Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
const prop = (v, k) => v !== null && typeof v === 'object' && own(v, k) ? v[k] : undefined;

function compileTemplates(trees) {
  const escaped = new Map();
  function value(v) {
    const text = asText(v);
    let s = escaped.get(text);
    if (s === undefined) { s = escape(text); escaped.set(text, s); }
    return s;
  }
  // Large include graphs use a bounded-size interpreter fallback instead of
  // creating an exponentially large generated function.
  function slow(name, vars, scopes, depth) {
    function get(path) {
      const key = path[0];
      let v;
      for (let i = scopes.length - 1; i >= -1; --i) {
        const o = i === -1 ? vars : scopes[i];
        if (own(o, key)) { v = o[key]; break; }
      }
      for (let i = 1; i < path.length; ++i) v = prop(v, path[i]);
      return v;
    }
    function walk(nodes, dep) {
      let out = '';
      for (const n of nodes) {
        if (n[0] === 0) out += n[1];
        else if (n[0] === 1) out += value(get(n[1]));
        else if (n[0] === 2) out += asText(get(n[1]));
        else if (n[0] === 4) {
          const branch = truth(get(n[2])) !== n[1] ? n[3] : n[4];
          if (branch !== null) out += walk(branch, dep);
        } else if (n[0] === 3) {
          const xs = get(n[2]);
          if (Array.isArray(xs)) xs.forEach((x, k) => {
            scopes.push({ [n[1]]: x, loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } });
            out += walk(n[3], dep); scopes.pop();
          });
        } else if (dep < 8 && trees.has(n[1])) out += walk(trees.get(n[1]), dep + 1);
      }
      return out;
    }
    return walk(trees.get(name), depth);
  }
  const compiled = new Map();
  const q = JSON.stringify;
  const dependencies = new Map(), memoIds = new Map(), memos = [];
  function freeNames(name, depth) {
    const key = name + '/' + depth;
    if (dependencies.has(key)) return dependencies.get(key);
    const result = new Set();
    function collect(nodes, bound) {
      for (const n of nodes) {
        if (n[0] === 1 || n[0] === 2) { if (!bound.has(n[1][0])) result.add(n[1][0]); }
        else if (n[0] === 3) {
          if (!bound.has(n[2][0])) result.add(n[2][0]);
          const local = new Set(bound); local.add(n[1]); local.add('loop');
          collect(n[3], local);
        } else if (n[0] === 4) {
          if (!bound.has(n[2][0])) result.add(n[2][0]);
          collect(n[3], bound); if (n[4] !== null) collect(n[4], bound);
        } else if (n[0] === 5 && depth < 8 && trees.has(n[1])) {
          for (const f of freeNames(n[1], depth + 1)) if (!bound.has(f)) result.add(f);
        }
      }
    }
    collect(trees.get(name), new Set());
    dependencies.set(key, result);
    return result;
  }
  // The generator owns these records, so known fields can use direct reads.
  // Unknown input values still go through the own-property-only accessor.
  const card = { title: 'string', url: 'string', date: 'string', date_long: 'string', summary: 'string', excerpt: 'string', reading_minutes: 'number', tags: '@tagref' };
  const schemas = {
    root: { site: 'site', tags: '@alltag', recent: '@card', page: 'page', posts: '@card', pager: 'pager', tag: 'tag' },
    site: { title: 'unknown', base_url: 'string' },
    card,
    page: { ...card, slug: 'string', content: 'string', toc: '@heading', newer: 'link', older: 'link', is_post: 'boolean' },
    pager: { number: 'number', total: 'number', url: 'string', newer_url: 'string', older_url: 'string' },
    alltag: { name: 'string', slug: 'string', url: 'string', count: 'number' },
    tagref: { name: 'string', slug: 'string', url: 'string' },
    tag: { name: 'string', slug: 'string', url: 'string', count: 'number', posts: '@card' },
    heading: { level: 'number', id: 'string', html: 'string' },
    link: { title: 'string', url: 'string', date: 'string', date_long: 'string' },
    loop: { index: 'number', first: 'boolean', last: 'boolean', length: 'number' }
  };
  for (const name of trees.keys()) {
    let id = 0, size = 0;
    const code = ['"use strict";const o=[];'];
    const scopes = [];
    let outputName = 'o', pending = [];
    function flush() {
      if (pending.length) { code.push(outputName, '.push(', pending.join(','), ');'); pending = []; }
    }
    function memoFor(name, depth) {
      let varying = null;
      for (const key of freeNames(name, depth)) {
        let binding;
        for (let i = scopes.length - 1; i >= 0; --i) {
          if (key === 'loop') return null;
          if (key === scopes[i].name) { binding = scopes[i]; break; }
        }
        if (binding !== undefined) {
          if (varying !== null || binding.type === 'unknown') return null;
          varying = { key, expr: binding.item };
        } else if (key === 'page' || key === 'posts' || key === 'pager' || key === 'tag') return null;
      }
      const key = name + '/' + depth + '/' + (varying === null ? '' : varying.key);
      let index = memoIds.get(key);
      if (index === undefined) { index = memos.length; memos.push(new Map()); memoIds.set(key, index); }
      return { index, expr: varying === null ? 'undefined' : varying.expr };
    }
    function path(p) {
      let expr, type;
      for (let i = scopes.length - 1; i >= 0; --i) {
        if (p[0] === 'loop') { expr = scopes[i].loop; type = 'loop'; break; }
        if (p[0] === scopes[i].name) { expr = scopes[i].item; type = scopes[i].type; break; }
      }
      if (expr === undefined) {
        type = own(schemas.root, p[0]) ? schemas.root[p[0]] : 'undefined';
        expr = type === 'undefined' ? '(void 0)' : 'v[' + q(p[0]) + ']';
      }
      for (let i = 1; i < p.length; ++i) {
        const key = p[i];
        if (type === 'unknown') expr = '$p(' + expr + ',' + q(key) + ')';
        else if (type[0] === '@' && key === 'length') { expr += '?.length'; type = 'number'; }
        else if (own(schemas, type) && own(schemas[type], key)) { expr += '?.[' + q(key) + ']'; type = schemas[type][key]; }
        else { expr = '(void 0)'; type = 'undefined'; }
      }
      return { expr, type };
    }
    function emit(nodes, depth) {
      for (const n of nodes) {
        ++size;
        if (n[0] === 0) pending.push(q(n[1]));
        else if (n[0] === 1 || n[0] === 2) pending.push((n[0] === 1 ? '$e(' : '$s(') + path(n[1]).expr + ')');
        else if (n[0] === 4) {
          flush();
          code.push('if(', n[1] ? '!' : '', '$t(', path(n[2]).expr, ')){');
          emit(n[3], depth);
          if (n[4] !== null) { code.push('}else{'); emit(n[4], depth); }
          code.push('}');
        } else if (n[0] === 3) {
          flush();
          const num = id++, a = 'a' + num, k = 'k' + num, x = 'x' + num, l = 'l' + num;
          const source = path(n[2]);
          code.push('{const ', a, '=', source.expr, ';if(Array.isArray(', a, ')){for(let ', k, '=0;', k, '<', a, '.length;', k, '++){if(!(', k, ' in ', a, '))continue;const ', x, '=', a, '[', k, '],', l, '={index:', k, '+1,first:', k, '===0,last:', k, '===', a, '.length-1,length:', a, '.length};');
          scopes.push({ name: n[1], item: x, loop: l, type: source.type[0] === '@' ? source.type.slice(1) : 'unknown' });
          emit(n[3], depth);
          scopes.pop(); code.push('}}}');
        } else if (depth < 8 && trees.has(n[1])) {
          const memo = size < 4000 ? memoFor(n[1], depth + 1) : null;
          if (memo !== null) {
            flush();
            const num = id++, result = 'r' + num, buffer = 'b' + num, parent = outputName;
            code.push('{let ', result, '=$m[', String(memo.index), '].get(', memo.expr, ');if(', result, '===undefined){const ', buffer, '=[];');
            outputName = buffer;
            emit(trees.get(n[1]), depth + 1);
            outputName = parent;
            code.push(result, '=', buffer, '.join("");$m[', String(memo.index), '].set(', memo.expr, ',', result, ');}', parent, '.push(', result, ');}');
          } else if (size < 4000) emit(trees.get(n[1]), depth + 1);
          else {
            const chain = scopes.map(s => '{[' + q(s.name) + ']:' + s.item + ',loop:' + s.loop + '}').join(',');
            pending.push('$i(' + q(n[1]) + ',v,[' + chain + '],' + String(depth + 1) + ')');
          }
        }
      }
      flush();
    }
    emit(trees.get(name), 0);
    code.push('return o.join("");');
    const factory = new Function('$p', '$e', '$s', '$t', '$i', '$m', 'return function(v){' + code.join('') + '}');
    compiled.set(name, factory(prop, value, asText, truth, slow, memos));
  }
  return compiled;
}

const escapable = c => c === '\\' || c === '`' || c === '*' || c === '_' || c === '[' || c === ']' || c === '(' || c === ')' || c === '#' || c === '+' || c === '-' || c === '.' || c === '!' || c === '>';
function findClose(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let a = j;
    while (a > from && s[a - 1] === '\\') --a;
    if ((j - a) % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}
function findStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let a = j;
    while (a > from && s[a - 1] === '\\') --a;
    if ((j - a) % 2 !== 0) j = s.indexOf('*', j + 1);
    else if (s[j + 1] === '*') j = s.indexOf('*', j + 2);
    else return j;
  }
  return -1;
}

const inlineSpecial = /[\\`*\[&<>"']/g;
function inline(s, link) {
  let out = '', p = 0;
  while (p < s.length) {
    inlineSpecial.lastIndex = p;
    const match = inlineSpecial.exec(s);
    if (match === null) return out + s.slice(p);
    const i = match.index, c = s[i];
    out += s.slice(p, i);
    if (entities[c] !== undefined) { out += entities[c]; p = i + 1; continue; }
    if (c === '\\') {
      if (i + 1 < s.length && escapable(s[i + 1])) { out += escape(s[i + 1]); p = i + 2; }
      else { out += '\\'; p = i + 1; }
    } else if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) { out += '<code>' + escape(s.slice(i + 1, j)) + '</code>'; p = j + 1; }
      else { out += '`'; p = i + 1; }
    } else if (c === '*') {
      const strong = s[i + 1] === '*', width = strong ? 2 : 1;
      const j = strong ? findClose(s, '**', i + 2) : findStar(s, i + 1);
      if (j > i + width) {
        const tag = strong ? 'strong' : 'em';
        out += '<' + tag + '>' + inline(s.slice(i + width, j), link) + '</' + tag + '>';
        p = j + width;
      } else { out += strong ? '**' : '*'; p = i + width; }
    } else {
      const k = findClose(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target && !/\s/.test(target)) {
        out += '<a href="' + escape(link(target)) + '">' + inline(s.slice(i + 1, k), link) + '</a>';
        p = m + 1;
      } else { out += '['; p = i + 1; }
    }
  }
  return out;
}

const blank = /^[ \t]*$/;
const fence = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const fenceEnd = /^```[ \t]*$/;
const heading = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const hr = /^(?:---|\*\*\*)[ \t]*$/;
const bullet = /^[-*] (.*)$/;
const ordered = /^(\d{1,9})\. (.*)$/;
const trim = s => {
  const a = s.charCodeAt(0), b = s.charCodeAt(s.length - 1);
  return a === 32 || a === 9 || b === 32 || b === 9 ? s.replace(/^[ \t]+|[ \t]+$/g, '') : s;
};

function markdown(src, link, slugify) {
  const lines = src.split('\n'), blocks = [], toc = [], ids = new Set();
  let excerpt = null, i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const first = line.charCodeAt(0);
    if (line === '' || ((first === 32 || first === 9) && blank.test(line))) { ++i; continue; }
    let m;
    if (first === 96 && (m = fence.exec(line))) {
      const lang = m[1];
      let text = '';
      ++i;
      while (i < lines.length && !(lines[i][0] === '`' && fenceEnd.test(lines[i]))) text += lines[i++] + '\n';
      ++i;
      blocks.push('<pre><code' + (lang ? ' class="language-' + lang + '"' : '') + '>' + escape(text) + '</code></pre>\n');
    } else if (first === 35 && (m = heading.exec(line)) && m[2] !== '') {
      const level = m[1].length, id = unique(slugify(m[2]), ids), html = inline(m[2], link);
      blocks.push('<h' + level + ' id="' + id + '">' + html + '</h' + level + '>\n');
      if (level === 2 || level === 3) toc.push({ level, id, html });
      ++i;
    } else if ((first === 45 || first === 42) && hr.test(line)) {
      blocks.push('<hr>\n'); ++i;
    } else if (line[0] === '>') {
      const parts = [];
      while (i < lines.length && lines[i][0] === '>') {
        const s = trim(lines[i++].replace(/^> ?/, ''));
        if (s !== '') parts.push(s);
      }
      blocks.push(parts.length ? '<blockquote>\n<p>' + inline(parts.join('\n'), link) + '</p>\n</blockquote>\n' : '<blockquote>\n</blockquote>\n');
    } else {
      const b = first === 45 || first === 42 ? bullet.exec(line) : null;
      const o = b === null && first >= 48 && first <= 57 ? ordered.exec(line) : null;
      if (b || o) {
        const isOrdered = o !== null, marker = isOrdered ? ordered : bullet;
        const start = isOrdered ? +o[1] : 1;
        let html = isOrdered ? (start === 1 ? '<ol>\n' : '<ol start="' + start + '">\n') : '<ul>\n';
        let parts = [];
        while (i < lines.length) {
          const item = marker.exec(lines[i]);
          if (item) {
            if (parts.length) html += '<li>' + inline(parts.join('\n'), link) + '</li>\n';
            parts = [trim(item[isOrdered ? 2 : 1])]; ++i;
          } else if (/^ {2,}\S/.test(lines[i])) { parts.push(trim(lines[i++])); }
          else break;
        }
        html += '<li>' + inline(parts.join('\n'), link) + '</li>\n' + (isOrdered ? '</ol>\n' : '</ul>\n');
        blocks.push(html);
      } else {
        const parts = [trim(line)]; ++i;
        while (i < lines.length) {
          const s = lines[i];
          const first = s.charCodeAt(0);
          if (s === '' || ((first === 32 || first === 9) && blank.test(s)) || (first === 96 && fence.test(s)) || (first === 35 && (m = heading.exec(s)) && m[2] !== '') || ((first === 45 || first === 42) && hr.test(s))) break;
          parts.push(trim(s)); ++i;
        }
        const html = inline(parts.join('\n'), link);
        if (excerpt === null) excerpt = html;
        blocks.push('<p>' + html + '</p>\n');
      }
    }
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

function resolve(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}

// Count complete groups of at most 200 words. This obtains ceil(words / 200)
// without allocating a substring for every word in the body.
const readingChunk = /(?:\S+\s*){1,200}/g;
function readingTime(body) {
  let n = 0;
  readingChunk.lastIndex = 0;
  while (readingChunk.test(body)) ++n;
  return n || 1;
}

export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [], trees = new Map(), sources = [], statics = [], bySource = new Map();
  for (const name of Object.keys(input.templates).sort(order)) {
    try { trees.set(name, parseTemplate(name, input.templates[name])); }
    catch (e) { if (!(e instanceof TemplateSyntaxError)) throw e; report.push(e.message); }
  }
  const templates = compileTemplates(trees);
  const slugCache = new Map();
  function slugify(text) {
    let s = slugCache.get(text);
    if (s === undefined) { s = slug(text); slugCache.set(text, s); }
    return s;
  }
  const takenDirs = new Map(), broken = new Set();
  for (const file of [...input.files].sort((a, b) => order(a.path, b.path))) {
    const path = file.path;
    if (!path.endsWith('.md')) { statics.push(file); continue; }
    const fm = front(file.content.includes('\r') ? file.content.replace(/\r\n?/g, '\n') : file.content);
    if (typeof fm === 'string') { report.push(`refused ${path}: ${fm}`); continue; }
    const data = fm.data, post = path.startsWith('posts/');
    const reserved = path.startsWith('tags/') ? 'tags' : path.startsWith('page/') ? 'page' : null;
    if (reserved !== null) { report.push(`refused ${path}: ${reserved}/ is the generator's own`); continue; }
    if (post && !own(data, 'date')) { report.push(`refused ${path}: a post needs a date`); continue; }
    const layout = data.layout ?? (post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${path}: layout "${layout}" is no template that parses`); continue; }
    if (data.draft === true) { report.push(`draft ${path}`); continue; }
    const cut = path.lastIndexOf('/'), dir = cut < 0 ? '' : path.slice(0, cut), outParent = post ? 'posts' : dir;
    let taken = takenDirs.get(outParent);
    if (taken === undefined) { taken = new Set(outParent === '' ? ['posts', 'tags', 'page'] : []); takenDirs.set(outParent, taken); }
    const s = unique(data.slug ?? slugify(data.title), taken);
    const outDir = outParent === '' ? s : outParent + '/' + s;
    const source = { path, dir, data, post, layout, slug: s, outDir, url: base + '/' + outDir + '/', body: fm.body, md: null, tags: null, card: null, link: null };
    sources.push(source); bySource.set(path, source);
  }
  const staticPaths = new Set(statics.map(f => f.path));
  for (const s of sources) {
    const links = new Map();
    function link(target) {
      let result = links.get(target);
      if (result !== undefined) return result;
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target[0] === '/' || target[0] === '#') return target;
      const hash = target.indexOf('#'), rel = hash < 0 ? target : target.slice(0, hash), frag = hash < 0 ? '' : target.slice(hash);
      const p = rel === '' ? null : resolve(s.dir, rel);
      const other = p === null ? undefined : bySource.get(p);
      if (other !== undefined) result = other.url + frag;
      else if (p !== null && staticPaths.has(p)) result = base + '/' + p + frag;
      else { result = target; broken.add(`broken-link ${s.path} -> ${target}`); }
      links.set(target, result);
      return result;
    }
    s.md = markdown(s.body, link, slugify);
  }
  const posts = sources.filter(s => s.post).sort((a, b) => order(b.data.date, a.data.date) || order(a.slug, b.slug));
  const tagsBySlug = new Map();
  function ownTags(s, isPost) {
    const out = [], seen = new Set();
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let t = tagsBySlug.get(slug);
      if (t === undefined) {
        t = { name, slug, url: isPost ? base + '/tags/' + slug + '/' : '', posts: [] };
        if (isPost) tagsBySlug.set(slug, t);
      }
      if (isPost) t.posts.push(s);
      out.push({ name: t.name, slug: t.slug, url: t.url });
    }
    return out;
  }
  for (const p of posts) p.tags = ownTags(p, true);
  for (const s of sources) if (!s.post) s.tags = ownTags(s, false);
  const tags = [...tagsBySlug.values()].sort((a, b) => b.posts.length - a.posts.length || order(a.slug, b.slug));
  for (const s of sources) {
    const data = s.data, date = data.date ?? '', date_long = data.date === undefined ? '' : longDate(data.date);
    s.card = { title: data.title, url: s.url, date, date_long, summary: data.summary ?? '', excerpt: s.md.excerpt, reading_minutes: readingTime(s.body), tags: s.tags };
    s.link = { title: data.title, url: s.url, date, date_long };
  }
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map(t => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map(p => p.card);
  function render(name, vars) {
    const t = templates.get(name);
    return t === undefined ? null : t({ site, tags: allTags, recent, ...vars });
  }
  const output = {};
  const neighbors = new Map();
  for (let i = 0; i < posts.length; ++i) neighbors.set(posts[i], [i === 0 ? null : posts[i - 1].link, i === posts.length - 1 ? null : posts[i + 1].link]);
  for (const s of sources) {
    const n = neighbors.get(s);
    const page = { ...s.card, slug: s.slug, content: s.md.html, toc: s.md.toc, newer: n ? n[0] : null, older: n ? n[1] : null, is_post: s.post };
    output[s.outDir + '/index.html'] = render(s.layout, { page });
  }
  const per = input.site.per_page, pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = k => k === 1 ? base + '/' : base + '/page/' + k + '/';
  for (let k = 1; k <= pages; ++k) {
    const html = render('index', { posts: posts.slice((k - 1) * per, k * per).map(p => p.card), pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) } });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map(p => p.card) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (own(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  report.push(...broken);
  report.sort(order);
  report.push(`built ${sources.length - posts.length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = report.join('\n') + '\n';
  return output;
}
