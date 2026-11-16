// parse.js — dependency-free ES module: parse(markdown) returns exactly the HTML
// marked 18.1.3 renders with default options (GFM on, breaks off).
// Single-pass block parser + inline parser emitting marked-exact HTML directly.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape text for HTML output. A '&' that begins a plausible entity reference
// (&name; / &#123; / &#x1a;) is left alone; everything else is escaped.
// Numeric references are decoded here (0 -> U+FFFD, out of range -> escaped).
function escapeText(s) {
  let out = '', i = 0, n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      const m = matchEntity(s, i);
      if (m) { out += m.html; i += m.len; continue; }
      out += '&amp;'; i++; continue;
    }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    out += s[i]; i++;
  }
  return out;
}

// Escape for code spans / attribute values where entities are NOT recognised:
// every & is escaped. (attr values use the same routine.)
function escapeRaw(s) {
  let out = '', i = 0, n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { out += '&amp;'; i++; continue; }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    out += s[i]; i++;
  }
  return out;
}

// Try to match an entity reference at s[i] ('&'). Returns {html, len} or null.
// Named references pass through unchanged; numeric ones decode.
function matchEntity(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 35) { // #
    let j = i + 2, hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      const ok = hex ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
                     : (c >= 48 && c <= 57);
      if (!ok) break;
      j++;
    }
    if (j === start || j >= n || s[j] !== ';') return null;
    const num = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (num === 0) return { html: '\uFFFD', len: j + 1 - i };
    if (num > 0x10FFFF || (num >= 0xD800 && num <= 0xDFFF)) return null;
    const ch = String.fromCodePoint(num);
    const esc = ESC[ch];
    return { html: esc !== undefined ? esc : ch, len: j + 1 - i };
  }
  // named: &[A-Za-z][A-Za-z0-9]*;
  if (!((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122))) return null;
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122))) break;
    j++;
  }
  if (j >= n || s[j] !== ';') return null;
  return { html: s.slice(i, j + 1), len: j + 1 - i };
}

function isSpace(c) { return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12; }
function isPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
// Unicode punctuation test (for flanking rules): ASCII punct or any non-alnum,
// non-space character.
function isUnicodePunct(ch) {
  const c = ch.codePointAt(0);
  if (c < 128) return isPunctCode(c);
  // Letters (incl. marks) and numbers are not punctuation; everything else is.
  return !/[A-Za-z0-9]/u.test(ch) && !/\s/u.test(ch) && !/\p{L}|\p{N}|\p{M}/u.test(ch);
}

// Unicode case fold for link labels: lowercase + ß->ss, ẞ->SS->ss etc.
function foldCase(s) {
  return s.toLowerCase().replace(/\u00DF/g, 'ss').replace(/\u1E9E/g, 'ss');
}
function normalizeLabel(s) {
  // collapse whitespace runs to single spaces, trim, case-fold
  return foldCase(s.replace(/\s+/g, ' ').trim());
}

// marked's cleanUrl: encodeURI, keep % as-is, reject dangerous protocols.
function cleanUrl(href) {
  let h = href;
  try { h = encodeURI(h).replace(/%25/g, '%'); } catch (e) { return null; }
  const t = h.replace(/&#[0-9]+;|&#x[0-9a-fA-F]+;|&[A-Za-z][A-Za-z0-9]*;/g, '').trim().toLowerCase();
  if (/^(javascript|vbscript|data):/.test(t)) {
    if (/^data:image\//.test(t)) return h;
    return null;
  }
  return h;
}

// ---------------- inline parsing ----------------

// A delimiter run in the output stream.
function makeDelim(ch, len, canOpen, canClose) {
  return { d: true, ch, len, canOpen, canClose, active: true,
           opens: [], closes: [] };
}
function renderDelim(d) {
  let s = '';
  for (const t of d.closes) s += '</' + t + '>';
  if (d.len > 0) s += d.ch.repeat(d.len);
  for (let k = d.opens.length - 1; k >= 0; k--) s += '<' + d.opens[k] + '>';
  return s;
}

// Unicode whitespace (CommonMark: Zs category + tab/LF/FF/CR) — used for
// flanking rules, where NBSP and other Unicode spaces count as whitespace.
function isUws(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000;
}

function flanking(src, i, j) {
  // run is src[i..j); returns {lf, rf, bp, ap} (left/right flanking,
  // before/after is Unicode punctuation)
  const before = i > 0 ? src[i - 1] : '';
  const after = j < src.length ? src[j] : '';
  const beforeWs = before === '' || isUws(before.charCodeAt(0));
  const afterWs = after === '' || isUws(after.charCodeAt(0));
  const beforePunct = before !== '' && isUnicodePunct(before);
  const afterPunct = after !== '' && isUnicodePunct(after);
  const lf = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const rf = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return { lf, rf, bp: beforePunct, ap: afterPunct };
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/;

// Try to parse a link destination starting at src[i].
// Returns {dest, next} (next = index after destination) or null.
function parseDest(src, i) {
  const n = src.length;
  if (i >= n) return null;
  if (src[i] === '<') {
    let j = i + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\n' || c === '<') return null;
      if (c === '\\' && j + 1 < n && isPunctCode(src.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === '>') return { dest: src.slice(i + 1, j), next: j + 1 };
      j++;
    }
    return null;
  }
  // bare destination: balanced parens, no spaces/control
  let j = i, depth = 0;
  while (j < n) {
    const c = src[j];
    if (c === ' ' || c === '\n' || c.charCodeAt(0) < 32) break;
    if (c === '\\' && j + 1 < n && isPunctCode(src.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === '(') { depth++; j++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; j++; continue;
    }
    j++;
  }
  if (j === i) return null;
  return { dest: src.slice(i, j), next: j };
}

// Parse a link title starting at src[i] (after optional whitespace already skipped
// by caller: i points at the quote char). Returns {title, next} or null.
function parseTitle(src, i) {
  const n = src.length;
  if (i >= n) return null;
  const q = src[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\' && j + 1 < n && isPunctCode(src.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === q) return { title: src.slice(i + 1, j), next: j + 1 };
      j++;
    }
    return null;
  }
  if (q === '(') {
    // parenthesised title: no unescaped '(' or ')' inside
    let j = i + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\' && j + 1 < n && isPunctCode(src.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === '(') return null;
      if (c === ')') return { title: src.slice(i + 1, j), next: j + 1 };
      j++;
    }
    return null;
  }
  return null;
}

// Skip spaces/tabs/newlines from i; returns new index.
function skipWs(src, i) {
  while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++;
  return i;
}

// Try to parse "( dest title? )" starting at src[i] == '('.
// Returns {href, title, next} or null. An empty "()" is a valid empty destination.
function parseInlineLink(src, i) {
  const n = src.length;
  let j = skipWs(src, i + 1);
  if (j >= n) return null;
  if (src[j] === ')') return { href: '', title: null, next: j + 1 };
  const d = parseDest(src, j);
  if (!d) return null;
  j = d.next;
  // after destination: whitespace* then optional title then whitespace* then ')'
  let k = j;
  while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
  let title = null;
  if (k < n && src[k] !== ')') {
    const t = parseTitle(src, k);
    if (!t) return null;
    title = t.title;
    k = t.next;
    while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
  }
  if (k >= n || src[k] !== ')') return null;
  return { href: d.dest, title, next: k + 1 };
}

// Parse a link label starting at src[i] == '['. The label ends at the first
// unescaped ']'. Returns {label, next} or null.
function parseLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const c = src[j];
    if (c === '\\' && j + 1 < n && isPunctCode(src.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === '[') return null;
    if (c === ']') return { label: src.slice(i + 1, j), next: j + 1 };
    j++;
  }
  return null;
}

function stripTags(s) {
  let out = '', i = 0, n = s.length;
  while (i < n) {
    if (s[i] === '<') {
      const j = s.indexOf('>', i);
      if (j === -1) { out += s.slice(i); break; }
      // An <img> tag contributes its alt text (cm-574).
      if (s.startsWith('<img ', i)) {
        const m = / alt="([^"]*)"/.exec(s.slice(i, j + 1));
        if (m) out += m[1];
      }
      i = j + 1;
    } else { out += s[i]; i++; }
  }
  return out;
}

// Render the output segments array to a string (resolving delimiters).
function renderOut(out) {
  let s = '';
  for (const seg of out) {
    if (typeof seg === 'string') s += seg;
    else if (seg.d) s += renderDelim(seg);
    else if (seg.bare) s += '<a href="' + escapeText(seg.href) + '">' + escapeText(seg.text) + '</a>';
    else if (seg.html) s += seg.html;
    else s += '['; // bracket marker renders as literal '['
  }
  return s;
}

// ---------------- extended autolinks (GFM) ----------------

function isEmailLocalChar(c) {
  const code = c.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    ".!#$%&'*+/=?^_`{|}~-".indexOf(c) !== -1;
}

// Validate a domain: labels of [A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])? separated by '.',
// at least one dot, last label all letters. Returns length of domain or 0.
function domainLen(s, i) {
  const n = s.length;
  let j = i, labels = 0, lastStart = i;
  while (j < n) {
    const c = s[j];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-') { j++; continue; }
    if (c === '.') {
      if (j === lastStart) return 0; // empty label
      if (s[j - 1] === '-') return 0; // label ends with '-'
      // trailing '.' (no label char after it) ends the domain here;
      // the '.' is trailing punctuation, not part of the domain
      if (j + 1 >= n || !((s[j + 1] >= 'a' && s[j + 1] <= 'z') || (s[j + 1] >= 'A' && s[j + 1] <= 'Z') || (s[j + 1] >= '0' && s[j + 1] <= '9') || s[j + 1] === '-')) break;
      labels++;
      j++;
      lastStart = j;
      continue;
    }
    break;
  }
  if (j === lastStart) return 0;
  if (s[j - 1] === '-') return 0;
  labels++;
  if (labels < 2) return 0;
  // last label must be all letters
  for (let k = lastStart; k < j; k++) {
    const c = s[k];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) return 0;
  }
  return j - i;
}

// marked's GFM _backpedal, applied until fixed point: drops a trailing run
// of punctuation (?!.,:;*_'\"~) and an unmatched trailing ')' one char at a
// time; a ')' survives when balanced by '(' or followed by more URL chars;
// ']' is NOT punctuation here (it stays, and is %5D-encoded in the href).
const BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
function trimAutolink(s) {
  let prev;
  do {
    prev = s;
    s = (BACKPEDAL.exec(s) || [''])[0];
  } while (prev !== s);
  return s;
}

// Try to match an extended autolink starting at src[i] (letter).
// inBrackets: inside link text the candidate must stop at ']' (marked
// suppresses autolinks there, so ']' always closes the label).
// Returns {href, text, next} or null.
function tryExtAutolink(src, i, inBrackets) {
  const n = src.length;
  const prev = i > 0 ? src[i - 1] : '';
  const prevOk = prev === '' || isSpace(prev.charCodeAt(0)) || isUnicodePunct(prev);
  if (!prevOk) return null;
  // www.
  if (src.startsWith('www.', i)) {
    const d = domainLen(src, i + 4);
    if (d === 0) return null;
    let j = i + 4 + d;
    while (j < n && !isSpace(src.charCodeAt(j)) && src[j] !== '<' && !(inBrackets && src[j] === ']')) j++;
    let url = trimAutolink(src.slice(i, j));
    if (url.length === 0) return null;
    // re-validate domain after trimming (trimming only touches the tail)
    const href = cleanUrl('http://' + url);
    if (href === null) return null;
    return { href, text: url, next: i + url.length };
  }
  // scheme
  let j = i;
  while (j < n && j < i + 32) {
    const c = src[j];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '+' || c === '.' || c === '-') { j++; continue; }
    break;
  }
  if (j - i < 2 || j >= n || src[j] !== ':') return null;
  const scheme = src.slice(i, j);
  if (src[j + 1] === '/' && src[j + 2] === '/') {
    // scheme:// authority + path
    let k = j + 3;
    while (k < n && !isSpace(src.charCodeAt(k)) && src[k] !== '<' && !(inBrackets && src[k] === ']')) k++;
    let url = trimAutolink(src.slice(i, k));
    if (url.length === 0) return null;
    // authority (before first '/') must contain a dot (after stripping user@ and :port)
    let authEnd = url.indexOf('/', scheme.length + 3);
    if (authEnd === -1) authEnd = url.length;
    let auth = url.slice(scheme.length + 3, authEnd);
    const at = auth.lastIndexOf('@');
    if (at !== -1) auth = auth.slice(at + 1);
    const colon = auth.lastIndexOf(':');
    if (colon !== -1) auth = auth.slice(0, colon);
    if (auth.indexOf('.') === -1) return null;
    if (domainLen(auth, 0) !== auth.length && auth.indexOf('.') === -1) return null;
    const href = cleanUrl(url);
    if (href === null) return null;
    return { href, text: url, next: i + url.length };
  }
  // scheme:email[/segment]
  const e = tryEmailAt(src, j + 1);
  if (!e) return null;
  let end = e.next;
  if (end < n && src[end] === '/') {
    let k = end + 1;
    while (k < n && !isSpace(src.charCodeAt(k)) && src[k] !== '<' && src[k] !== '/') k++;
    if (k > end + 1) end = k;
  }
  const url = src.slice(i, end);
  const href = cleanUrl(url);
  if (href === null) return null;
  return { href, text: url, next: end };
}

// Is the '_' run ending just before src[i] an emphasis delimiter (can
// open or close)? If so it is not part of a preceding word, so an email
// may start at i even though '_' is an email-local char.
function underscoreRunIsDelim(src, i) {
  let k = i - 1;
  while (k >= 0 && src[k] === '_') k--;
  const f = flanking(src, k + 1, i);
  const canOpen = f.lf && (!f.rf || f.bp);
  const canClose = f.rf && (!f.lf || f.ap);
  return canOpen || canClose;
}

// Try to match an email address starting at src[i]. Returns {next} or null.
// delims (inlineParse's pending openers) is optional: when provided, a
// trailing '_' after the domain is handled like marked's regex — if the
// '_' run closes a pending '_' opener the full email links, otherwise the
// domain backtracks to the last '.' (marked links the shorter address).
function tryEmailAt(src, i, delims) {
  const n = src.length;
  let j = i;
  while (j < n && isEmailLocalChar(src[j])) j++;
  if (j === i || j >= n || src[j] !== '@') return null;
  const local = src.slice(i, j);
  if (local.length === 0) return null;
  const d = domainLen(src, j + 1);
  if (d === 0) return null;
  const end = j + 1 + d;
  // marked's email regex ends with (?![\w-]): only a word char or '-'
  // can extend the match; '*', '!', etc. do not block it.
  if (end < n) {
    const c = src[end];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '-') {
      // Only '_' can block here (letters/digits/'-' are domain chars and
      // would have been consumed by domainLen).
      if (delims && c === '_') {
        let k = end;
        while (k < n && src[k] === '_') k++;
        const runLen = k - end;
        const f = flanking(src, end, k);
        const canClose = f.rf && (!f.lf || f.ap);
        const canOpen = f.lf && (!f.rf || f.bp);
        let isCloser = false;
        if (canClose) {
          for (let t = delims.length - 1; t >= 0; t--) {
            const dm = delims[t];
            if (dm.ch === '_' && dm.active && dm.canOpen && dm.len > 0) {
              if (!(canOpen && (dm.len + runLen) % 3 === 0)) isCloser = true;
              break;
            }
          }
        }
        if (isCloser) return { next: end };
        // Backtrack the domain to the last '.', keeping >= 2 labels.
        let p = -1;
        for (let q = j + 1; q < end; q++) if (src[q] === '.') p = q;
        if (p !== -1) {
          let hasDot = false;
          for (let q = j + 1; q < p; q++) if (src[q] === '.') { hasDot = true; break; }
          if (hasDot) {
            const lc = src[p - 1];
            if ((lc >= 'a' && lc <= 'z') || (lc >= 'A' && lc <= 'Z') || (lc >= '0' && lc <= '9')) return { next: p };
          }
        }
      }
      return null;
    }
  }
  return { next: end };
}

// Try a <...> autolink or raw HTML tag starting at src[i] == '<'.
// Returns {html, next} or null.
function tryAngle(src, i) {
  const n = src.length;
  // autolink: <scheme:...> or <email>
  if (i + 1 < n) {
    const c = src[i + 1];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
      // scheme
      let j = i + 1;
      while (j < n && j < i + 33) {
        const ch = src[j];
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '+' || ch === '.' || ch === '-') { j++; continue; }
        break;
      }
      if (j < n && src[j] === ':' && j - (i + 1) >= 2) {
        let k = j + 1;
        while (k < n && src[k] !== '>' && src[k] !== ' ' && src[k] !== '\n' && src[k] !== '\t') k++;
        if (k < n && src[k] === '>' && k > j + 1) {
          const uri = src.slice(i + 1, k);
          const href = cleanUrl(uri);
          if (href === null) return null;
          return { html: '<a href="' + escapeText(href) + '">' + escapeText(uri) + '</a>', next: k + 1 };
        }
      }
      // email
      const e = tryEmailAt(src, i + 1);
      if (e) {
        let k = e.next;
        if (k < n && src[k] === '>') {
          const em = src.slice(i + 1, k);
          return { html: '<a href="mailto:' + escapeText(em) + '">' + escapeText(em) + '</a>', next: k + 1 };
        }
      }
    }
  }
  // raw HTML: comment, PI, declaration, CDATA, close tag, open tag
  if (src.startsWith('<!--', i)) {
    // abrupt closing: <!--> and <!---> are complete (empty) comments
    if (src[i + 4] === '>') return { html: src.slice(i, i + 5), next: i + 5 };
    if (src[i + 4] === '-' && src[i + 5] === '>') return { html: src.slice(i, i + 6), next: i + 6 };
    const k = src.indexOf('-->', i + 4);
    if (k !== -1) return { html: src.slice(i, k + 3), next: k + 3 };
    return null;
  }
  if (src.startsWith('<?', i)) {
    const k = src.indexOf('?>', i + 2);
    if (k !== -1) return { html: src.slice(i, k + 2), next: k + 2 };
    return null;
  }
  if (src.startsWith('<![CDATA[', i)) {
    const k = src.indexOf(']]>', i + 9);
    if (k !== -1) return { html: src.slice(i, k + 3), next: k + 3 };
    return null;
  }
  if (src.startsWith('<!', i)) {
    // declaration: <! + letter ... >
    if (i + 2 < n && /[A-Za-z]/.test(src[i + 2])) {
      const k = src.indexOf('>', i + 2);
      if (k !== -1) return { html: src.slice(i, k + 1), next: k + 1 };
    }
    return null;
  }
  // open / close tag
  let j = i + 1;
  let closing = false;
  if (src[j] === '/') { closing = true; j++; }
  if (j >= n || !/[A-Za-z]/.test(src[j])) return null;
  while (j < n && /[A-Za-z0-9-]/.test(src[j])) j++;
  const nameEnd = j;
  const tagName = src.slice(i + 1, nameEnd).toLowerCase();
  if (closing) {
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
    if (j < n && src[j] === '>') {
      const html = src.slice(i, j + 1);
      // marked's endATag is exactly </a> (case-insensitive): </a > does not clear.
      if (/^<\/a>/i.test(html)) IN_LINK = false;
      return { html, next: j + 1 };
    }
    return null;
  }
  // attributes (each must be preceded by whitespace)
  for (;;) {
    let ws = 0;
    while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) { j++; ws++; }
    if (j >= n) return null;
    if (src[j] === '>') {
      // marked's startATag is /^<a /i: <a> alone does not set inLink.
      if (tagName === 'a' && src[nameEnd] === ' ') IN_LINK = true;
      return { html: src.slice(i, j + 1), next: j + 1 };
    }
    if (src[j] === '/' && j + 1 < n && src[j + 1] === '>') {
      if (tagName === 'a' && src[nameEnd] === ' ') IN_LINK = true;
      return { html: src.slice(i, j + 2), next: j + 2 };
    }
    if (ws === 0) return null;
    // attribute name
    if (!/[A-Za-z_:][A-Za-z0-9_.:-]*/.test(src.slice(j, j + 1))) return null;
    while (j < n && /[A-Za-z0-9_.:-]/.test(src[j])) j++;
    // optional whitespace then '=' for a value (look ahead without
    // consuming, so a valueless attribute keeps its separator for the
    // next attribute's whitespace check)
    let k = j;
    while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
    if (k < n && src[k] === '=') {
      j = k + 1;
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
      if (j >= n) return null;
      if (src[j] === '"' || src[j] === "'") {
        const q = src[j];
        j++;
        while (j < n && src[j] !== q) j++;
        if (j >= n) return null;
        j++;
      } else {
        let s0 = j;
        while (j < n && !/[\s"'=<>`]/.test(src[j])) j++;
        if (j === s0) return null;
      }
    }
  }
}

// Process a closer delimiter: look back for openers and form em/strong/del.
function processCloser(closer, delims, brackets, src, refs) {
  const ch = closer.ch;
  while (closer.len > 0) {
    let oi = -1;
    for (let k = delims.length - 1; k >= 0; k--) {
      const o = delims[k];
      if (o.ch !== ch || !o.active || o.len === 0 || !o.canOpen) continue;
      // Odd-match rule (spec rule 9): if either delimiter can both open
      // and close, the sum of the run lengths must not be a multiple of 3
      // unless both lengths are multiples of 3.
      const eitherBoth = (closer.canOpen && closer.canClose) || (o.canOpen && o.canClose);
      if (eitherBoth && (o.len + closer.len) % 3 === 0 && (o.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
      // No crossing a link bracket: an opener outside a '[' that will
      // form a link cannot match a closer inside it (and vice versa).
      // A bracket that never forms a link (no '(' or '[' after its ']')
      // does not block (cm-523).
      if (brackets && src) {
        let blocked = false;
        for (let b = 0; b < brackets.length; b++) {
          const br = brackets[b];
          if (!br.active || br.outIdx <= o.outIdx || br.outIdx >= closer.outIdx) continue;
          let j = br.srcIdx + 1;
          while (j < src.length && src[j] !== ']') {
            if (src[j] === '\\' && j + 1 < src.length) j++;
            j++;
          }
          if (j < src.length && (src[j + 1] === '(' || src[j + 1] === '[')) { blocked = true; break; }
          // Shortcut reference: the label itself is a defined ref.
          if (refs && j > br.srcIdx + 1 && refs.has(normalizeLabel(src.slice(br.srcIdx + 1, j)))) { blocked = true; break; }
        }
        if (blocked) continue;
      }
      oi = k; break;
    }
    if (oi === -1) break;
    const o = delims[oi];
    if (ch === '~') {
      const use = (o.len >= 2 && closer.len >= 2) ? 2 : 1;
      o.opens.push('del'); closer.closes.push('del');
      o.len -= use; closer.len -= use;
    } else {
      const use = (o.len >= 2 && closer.len >= 2) ? 2 : 1;
      if (use === 2) { o.opens.push('strong'); closer.closes.push('strong'); }
      else { o.opens.push('em'); closer.closes.push('em'); }
      o.len -= use; closer.len -= use;
    }
    // No crossing a formed span: openers strictly between the matched
    // opener and this closer can no longer match a closer outside the span.
    for (let k = oi + 1; k < delims.length; k++) delims[k].active = false;
    if (o.len === 0) { o.active = false; delims.splice(oi, 1); }
  }
}

function unescapeStr(s) {
  return s.replace(/\\([!-/:-@\[-`{-~])/g, '$1');
}

// The inline parser. src is paragraph/cell/heading text (lines joined with \n).
function inlineParse(src, refs) {
  const n = src.length;
  const out = [];
  const delims = [];
  const brackets = [];
  let i = 0, textStart = 0;
  function flush(to) {
    if (to > textStart) out.push(escapeText(src.slice(textStart, to)));
  }

  while (i < n) {
    const c = src[i];

    // code span
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const run = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (src[k] === '`') {
          let m = k;
          while (m < n && src[m] === '`') m++;
          if (m - k === run) { found = k; break; }
          k = m;
        } else k++;
      }
      if (found === -1) { i = j; continue; }
      flush(i);
      let content = src.slice(j, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      out.push('<code>' + escapeRaw(content) + '</code>');
      i = found + run; textStart = i;
      continue;
    }

    // backslash escape / hard break
    if (c === '\\') {
      if (i + 1 < n && src[i + 1] === '\n') {
        flush(i); out.push('<br>');
        i += 2;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        textStart = i; continue;
      }
      if (i + 1 < n && isPunctCode(src.charCodeAt(i + 1))) {
        flush(i); out.push(escapeText(src[i + 1])); i += 2; textStart = i; continue;
      }
      i++; continue;
    }

    // emphasis / strikethrough runs
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && src[j] === c) j++;
      const len = j - i;
      if (c === '~' && len !== 2 && len !== 1) { i = j; continue; }
      flush(i);
      const f = flanking(src, i, j);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = f.lf && (!f.rf || f.bp);
        canClose = f.rf && (!f.lf || f.ap);
      } else {
        canOpen = f.lf; canClose = f.rf;
      }
      const d = makeDelim(c, len, canOpen, canClose);
      d.outIdx = out.length;
      out.push(d);
      if (canClose) processCloser(d, delims, brackets, src, refs);
      if (canOpen && d.len > 0) delims.push(d);
      i = j; textStart = i;
      continue;
    }

    // image / link open bracket
    if (c === '!' && i + 1 < n && src[i + 1] === '[') {
      flush(i);
      out.push('!');
      const bangIdx = out.length - 1;
      const marker = { b: true, active: true, isImage: true, bangIdx, srcIdx: i + 1, outIdx: out.length, inLink: IN_LINK };
      out.push(marker);
      brackets.push(marker);
      i += 2; textStart = i;
      continue;
    }
    if (c === '[') {
      flush(i);
      const marker = { b: true, active: true, isImage: false, bangIdx: -1, srcIdx: i, outIdx: out.length, inLink: IN_LINK };
      out.push(marker);
      brackets.push(marker);
      i++; textStart = i;
      continue;
    }

    // link close bracket
    if (c === ']') {
      if (brackets.length === 0) { i++; continue; }
      const b = brackets[brackets.length - 1];
      if (!b.active) { brackets.pop(); i++; continue; }
      flush(i);
      textStart = i;
      const formed = tryFormLink(src, i, b, out, delims, brackets, refs);
      if (formed !== null) { i = formed; textStart = i; continue; }
      brackets.pop();
      i++; continue;
    }

    // angle: autolink or raw HTML
    if (c === '<') {
      const a = tryAngle(src, i);
      if (a) {
        flush(i); out.push(a.html); i = a.next; textStart = i; continue;
      }
      i++; continue;
    }

    // entity
    if (c === '&') {
      const e = matchEntity(src, i);
      if (e) {
        flush(i); out.push(e.html); i += e.len; textStart = i; continue;
      }
      flush(i); out.push('&amp;'); i++; textStart = i; continue;
    }

    // line ending: hard or soft break
    if (c === '\n') {
      let k = i - 1, spaces = 0;
      while (k >= textStart && src[k] === ' ') { spaces++; k--; }
      if (spaces >= 2) {
        flush(i - spaces);
        out.push('<br>');
        i++;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        textStart = i;
      } else {
        flush(i);
        out.push('\n');
        i++; textStart = i;
      }
      continue;
    }

    // extended autolinks: www. / scheme (suppressed while inLink)
    if (!IN_LINK && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) {
      const a = tryExtAutolink(src, i, brackets.length > 0);
      if (a) {
        flush(i);
        out.push({ a: 1, bare: 1, href: a.href, text: a.text });
        i = a.next; textStart = i; continue;
      }
    }
    // email autolink at word start (suppressed while inLink)
    if (!IN_LINK && isEmailLocalChar(c) && (i === 0 || !isEmailLocalChar(src[i - 1]) || (src[i - 1] === '_' && underscoreRunIsDelim(src, i)))) {
      if (src.indexOf('@', i, Math.min(n, i + 64)) !== -1) {
        const e = tryEmailAt(src, i, delims);
        if (e) {
          const em = src.slice(i, e.next);
          flush(i);
          out.push({ a: 1, bare: 1, href: 'mailto:' + em, text: em });
          i = e.next; textStart = i; continue;
        }
      }
    }

    i++;
  }
  flush(n);
  return renderOut(out);
}

// marked's link-label pattern (its `re`, with the nested-bracket part
// inlined): a label may contain nested [...], backslash escapes, code
// spans, or a run of backticks before ']', but no bare backtick. A label
// that fails it cannot form a link (the '[' stays literal).
const LABEL_RE = /^(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*\]$/;

// Attempt to form a link/image at src[i] == ']' with open bracket b.
// Returns the index after the link, or null if no link forms.
function tryFormLink(src, i, b, out, delims, brackets, refs) {
  // A link inside this link's text vetoes the outer LINK (marked's
  // linkEmitted) — but not an outer IMAGE, whose alt text may contain one.
  // The inner link stays, the outer '[' stays literal.
  if (!b.isImage) {
    for (let k = b.outIdx + 1; k < out.length; k++) {
      const seg = out[k];
      if (seg && typeof seg === 'object' && seg.link) return null;
    }
  }
  const textRaw = src.slice(b.srcIdx + 1, i);
  // the label pattern is followed by ']' in marked's regex (the ``+(?=])
  // alternative needs it), so validate the label plus its closing bracket
  if (!LABEL_RE.test(textRaw + ']')) return null;
  let href = null, title = null, next = -1;

  if (i + 1 < src.length && src[i + 1] === '(') {
    const r = parseInlineLink(src, i + 1);
    if (r) { href = r.href; title = r.title; next = r.next; }
    else {
      // failed inline link falls back to the shortcut reference
      const ref = refs.get(normalizeLabel(textRaw));
      if (!ref) return null;
      href = ref.href; title = ref.title; next = i + 1;
    }
  } else if (i + 1 < src.length && src[i + 1] === '[') {
    const lab = parseLabel(src, i + 1);
    if (!lab) {
      // no closing ']' for the label: fall back to the shortcut reference
      const ref = refs.get(normalizeLabel(textRaw));
      if (!ref) return null;
      href = ref.href; title = ref.title; next = i + 1;
    } else if (lab.label !== '') {
      const ref = refs.get(normalizeLabel(lab.label));
      if (!ref) return null; // failed full reference: no shortcut fallback
      href = ref.href; title = ref.title; next = lab.next;
    } else {
      const ref = refs.get(normalizeLabel(textRaw));
      if (!ref) return null;
      href = ref.href; title = ref.title; next = lab.next;
    }
  } else {
    const ref = refs.get(normalizeLabel(textRaw));
    if (!ref) return null;
    href = ref.href; title = ref.title; next = i + 1;
  }

  const clean = cleanUrl(unescapeStr(href));
  if (clean === null) return null;

  // Bare autolinks inside link text are suppressed (marked's inLink):
  // downgrade them to plain text now that the link is known to form.
  for (let k = b.outIdx + 1; k < out.length; k++) {
    const seg = out[k];
    if (seg && typeof seg === 'object' && seg.bare) out[k] = escapeText(seg.text);
  }
  const textHtml = renderOut(out.slice(b.outIdx + 1));

  let html;
  if (b.isImage) {
    const alt = stripTags(textHtml);
    html = '<img src="' + escapeText(clean) + '" alt="' + alt + '"';
    if (title !== null && title !== undefined) html += ' title="' + escapeText(unescapeStr(title)) + '"';
    html += '>';
    out[b.bangIdx] = '';
  } else {
    html = '<a href="' + escapeText(clean) + '"';
    if (title !== null && title !== undefined) html += ' title="' + escapeText(unescapeStr(title)) + '"';
    html += '>' + textHtml + '</a>';
  }
  // replace bracket + text with the link; drop delimiters/brackets inside it
  out.splice(b.outIdx, out.length - b.outIdx, { a: 1, link: b.isImage ? 0 : 1, html });
  // marked's De restores inLink to its pre-link value: tag toggles inside
  // the link text do not leak out.
  IN_LINK = b.inLink;
  for (let k = delims.length - 1; k >= 0; k--) {
    if (delims[k].outIdx > b.outIdx) delims.splice(k, 1);
  }
  // A link deactivates preceding *link* brackets (image brackets survive);
  // an image deactivates nothing. Remove this bracket from the stack.
  const bi = brackets.indexOf(b);
  brackets.splice(bi, 1);
  if (!b.isImage) {
    for (const br of brackets) if (!br.isImage) br.active = false;
  }
  // brackets opened inside the link text are gone too
  for (let k = brackets.length - 1; k >= 0; k--) {
    if (brackets[k].outIdx > b.outIdx) brackets.splice(k, 1);
  }
  return next;
}

// ---------------- block parsing ----------------

// A source line: {s: text, c: absolute column of its first character}.
// Container stripping changes c, so tabs later in the line still expand
// against their original columns.
function L(s, c) { return { s, c }; }

function firstNonWs(ln) {
  let col = ln.c, idx = 0;
  const line = ln.s;
  while (idx < line.length) {
    const ch = line[idx];
    if (ch === ' ') { col++; idx++; }
    else if (ch === '\t') { col += 4 - (col % 4); idx++; }
    else break;
  }
  return { col: col - ln.c, abs: col, idx, pend: 0 };
}
function isBlankLine(ln) {
  const line = ln.s;
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}
// Consume leading whitespace up to absolute column targetAbs.
// Returns {ok, idx, pend, col}: col is the absolute column reached.
function consumeIndent(ln, targetAbs) {
  let col = ln.c, idx = 0;
  const line = ln.s;
  while (col < targetAbs && idx < line.length) {
    const ch = line[idx];
    if (ch === ' ') { col++; idx++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= targetAbs) { col += w; idx++; }
      else return { ok: true, idx, pend: col + w - targetAbs, col: targetAbs };
    } else return { ok: false, idx, pend: 0, col };
  }
  return { ok: col >= targetAbs, idx, pend: 0, col };
}
function restOf(ln, c) {
  if (c.pend > 0) return ' '.repeat(c.pend) + ln.s.slice(c.idx + 1);
  return ln.s.slice(c.idx);
}
// A new line object for the text after consuming whitespace (cons from consumeIndent).
function restLine(ln, cons) {
  const s = cons.pend > 0 ? ' '.repeat(cons.pend) + ln.s.slice(cons.idx + 1) : ln.s.slice(cons.idx);
  return L(s, cons.col);
}

function matchAtx(s) {
  let k = 0;
  while (k < s.length && s[k] === '#') k++;
  if (k === 0 || k > 6) return null;
  if (k < s.length && s[k] !== ' ' && s[k] !== '\t') return null;
  let t = s.slice(k).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  // closing sequence: trailing #'s preceded by whitespace, or the whole text
  if (/^#+$/.test(t)) t = '';
  else {
    const m = t.match(/^(.*?)[ \t]+#+$/);
    if (m) t = m[1];
  }
  return { level: k, text: t };
}

function matchFence(s) {
  const ch = s[0];
  if (ch !== '`' && ch !== '~') return null;
  let k = 0;
  while (k < s.length && s[k] === ch) k++;
  if (k < 3) return null;
  const info = s.slice(k);
  if (ch === '`' && info.indexOf('`') !== -1) return null;
  return { ch, len: k, info };
}

function isFenceClose(s, fence) {
  let k = 0;
  while (k < s.length && s[k] === fence.ch) k++;
  if (k < fence.len) return false;
  for (let i = k; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

function isThematic(s) {
  let c = '', count = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t') continue;
    if (c === '') c = ch;
    if (ch !== c) return false;
    count++;
  }
  return count >= 3 && (c === '*' || c === '-' || c === '_');
}

function setextLevel(s) {
  // a run of = or - followed only by spaces/tabs
  if (s.length === 0) return 0;
  const ch = s[0];
  if (ch !== '=' && ch !== '-') return 0;
  let i = 0;
  while (i < s.length && s[i] === ch) i++;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (i !== s.length) return 0;
  return ch === '=' ? 1 : 2;
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// HTML block type (0 = not an HTML block start). Type 7 does not interrupt paragraphs.
function htmlBlockType(s) {
  const low = s.toLowerCase();
  if (low.startsWith('<script') || low.startsWith('<pre') || low.startsWith('<style') || low.startsWith('<textarea')) {
    const name = low.startsWith('<textarea') ? 9 : low.startsWith('<script') ? 7 : low.startsWith('<style') ? 6 : 4;
    const c = low[name];
    if (c === undefined || c === ' ' || c === '\t' || c === '>' || c === '\n') return 1;
    return 0;
  }
  if (low.startsWith('<!--')) return 2;
  if (low.startsWith('<?')) return 3;
  if (low.startsWith('<!') && low.length > 2 && /[a-z]/.test(low[2])) return 4;
  if (low.startsWith('<![cdata[')) return 5;
  // type 6: block tag
  let j = 0, closing = false;
  if (s[0] !== '<') return 0;
  j = 1;
  if (s[1] === '/') { closing = true; j = 2; }
  let k = j;
  while (k < s.length && /[A-Za-z0-9-]/.test(s[k])) k++;
  if (k === j) return 0;
  const name = low.slice(j, k);
  const c = s[k];
  if (c !== undefined && c !== ' ' && c !== '\t' && c !== '>' && c !== '\n' && c !== '/') return 0;
  if (BLOCK_TAGS.has(name)) return 6;
  // type 7: a complete open or closing tag alone on the line
  const tend = parseTagEnd(s, 0);
  if (tend !== -1) {
    let t = tend;
    while (t < s.length && (s[t] === ' ' || s[t] === '\t')) t++;
    if (t === s.length) return 7;
  }
  return 0;
}

// Parse an HTML tag starting at s[i] ('<'). Returns index after '>' or -1.
function parseTagEnd(s, i) {
  const n = s.length;
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= n || !/[A-Za-z]/.test(s[j])) return -1;
  while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
  for (;;) {
    let ws = 0;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; ws++; }
    if (j >= n) return -1;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/' && j + 1 < n && s[j + 1] === '>') return j + 2;
    if (ws === 0 || closing) return -1;
    while (j < n && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (k < n && s[k] === '=') {
      j = k + 1;
      while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (j >= n) return -1;
      if (s[j] === '"' || s[j] === "'") {
        const q = s[j];
        j++;
        while (j < n && s[j] !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        const s0 = j;
        while (j < n && !/[\s"'=<>`]/.test(s[j])) j++;
        if (j === s0) return -1;
      }
    }
  }
}

function htmlBlockEnd(type, line) {
  const low = line.toLowerCase();
  switch (type) {
    case 1:
      return low.indexOf('</script') !== -1 || low.indexOf('</pre') !== -1 || low.indexOf('</style') !== -1 || low.indexOf('</textarea') !== -1;
    case 2: return low.indexOf('-->') !== -1;
    case 3: return low.indexOf('?>') !== -1;
    case 4: return low.indexOf('>') !== -1;
    case 5: return low.indexOf(']]>') !== -1;
    default: return false;
  }
}

// Match a list marker at the start of s (indent-stripped line content).
// baseAbs is the absolute column of the marker. Returns contentIndent
// (relative to the marker column) and contentColAbs (absolute column of the
// first content character).
function matchListMarker(s, baseAbs) {
  if (s.length === 0) return null;
  const c0 = s[0];
  if (c0 === '-' || c0 === '+' || c0 === '*') {
    if (s.length === 1) return { ordered: false, bullet: c0, markerLen: 1, contentIndent: 2, contentColAbs: baseAbs + 2, empty: true, content: '' };
    if (s[1] !== ' ' && s[1] !== '\t') return null;
    let k = 1, cols = 0;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) {
      if (s[k] === ' ') { cols++; k++; }
      else { const w = 4 - ((baseAbs + 1 + cols) % 4); cols += w; k++; }
    }
    const rest = s.slice(k);
    if (rest === '') return { ordered: false, bullet: c0, markerLen: 1, contentIndent: 2, contentColAbs: baseAbs + 2, empty: true, content: '' };
    if (cols >= 5) return { ordered: false, bullet: c0, markerLen: 1, contentIndent: 2, contentColAbs: baseAbs + 2, empty: false, content: ' '.repeat(cols - 1) + rest };
    return { ordered: false, bullet: c0, markerLen: 1, contentIndent: 1 + cols, contentColAbs: baseAbs + 1 + cols, empty: false, content: rest };
  }
  let k = 0;
  while (k < s.length && s[k] >= '0' && s[k] <= '9') k++;
  if (k === 0 || k > 9) return null;
  if (k >= s.length || (s[k] !== '.' && s[k] !== ')')) return null;
  const num = parseInt(s.slice(0, k), 10);
  if (k + 1 >= s.length) return { ordered: true, start: num, delim: s[k], markerLen: k + 1, contentIndent: k + 2, contentColAbs: baseAbs + k + 2, empty: true, content: '' };
  if (s[k + 1] !== ' ' && s[k + 1] !== '\t') return null;
  const markerLen = k + 1;
  let j = k + 1, cols = 0;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) {
    if (s[j] === ' ') { cols++; j++; }
    else { const w = 4 - ((baseAbs + markerLen + cols) % 4); cols += w; j++; }
  }
  const rest = s.slice(j);
  if (rest === '') return { ordered: true, start: num, delim: s[k], markerLen, contentIndent: markerLen + 1, contentColAbs: baseAbs + markerLen + 1, empty: true, content: '' };
  if (cols >= 5) return { ordered: true, start: num, delim: s[k], markerLen, contentIndent: markerLen + 1, contentColAbs: baseAbs + markerLen + 1, empty: false, content: ' '.repeat(cols - 1) + rest };
  return { ordered: true, start: num, delim: s[k], markerLen, contentIndent: markerLen + cols, contentColAbs: baseAbs + markerLen + cols, empty: false, content: rest };
}

// Does s start a block that can interrupt a paragraph?
function startsBlock(s, inList) {
  if (s === '') return false;
  if (s[0] === '>') return true;
  if (matchAtx(s)) return true;
  if (matchFence(s)) return true;
  if (isThematic(s)) return true;
  const ht = htmlBlockType(s);
  if (ht >= 1 && ht <= 6) return true;
  const m = matchListMarker(s, 0);
  // Inside a list item, an ordered list interrupts a paragraph whatever its
  // start number; outside, only start 1 does.
  if (m && !m.empty && (!m.ordered || m.start === 1 || inList)) return true;
  return false;
}

// Is the innermost content of s (after stripping any nested '>' markers and
// list markers) paragraph text? Used to decide whether a lazy continuation
// line may continue the open paragraph through nested containers.
function deepIsPara(s) {
  let t = s;
  for (;;) {
    let i = 0;
    while (i < t.length && t[i] === ' ' && i < 3) i++;
    if (i < t.length && t[i] === '>') {
      let j = i + 1;
      if (j < t.length && (t[j] === ' ' || t[j] === '\t')) j++;
      t = t.slice(j);
      continue;
    }
    const rest = t.slice(i);
    const m = matchListMarker(rest, 0);
    if (m) {
      if (m.empty) return false;
      t = m.content;
      continue;
    }
    let col = 0, k = 0;
    while (k < t.length && (t[k] === ' ' || t[k] === '\t')) {
      if (t[k] === ' ') col++;
      else col += 4 - (col % 4);
      k++;
    }
    if (col >= 4) return false;
    const stripped = t.slice(k);
    if (stripped === '') return false;
    return !startsBlock(stripped);
  }
}

// Strip leading link reference definitions from paragraph lines (joined text).
// Records definitions in refs (first definition wins). Returns remaining text.
// Def grammar (per marked): [label]: <spaces> dest <spaces> title? <spaces>
//   - after ':': spaces only on the line, then optionally ONE newline, then
//     leading indent (spaces/tabs) of the next line, then the destination.
//     A tab on the ':' line or a blank line before the dest invalidates.
//   - same-line title needs >=1 space before it; an unparseable same-line
//     title or junk/tab after it invalidates the whole definition.
//   - a title may sit on the next line (leading indent may include tabs);
//     if it fails to parse or has junk/tab after it, the def stands WITHOUT
//     the title and that line remains as text.
function stripRefDefs(lines, refs) {
  const src = lines.join('\n');
  const n = src.length;
  let pos = 0;
  for (;;) {
    let p = pos;
    while (p < n && (src[p] === ' ' || src[p] === '\t' || src[p] === '\n')) p++;
    if (p >= n || src[p] !== '[') break;
    const lab = parseLabel(src, p);
    if (!lab || lab.label === '' || lab.label.length > 999) break;
    const key = normalizeLabel(lab.label);
    if (key === '') break;
    let q = lab.next;
    if (q >= n || src[q] !== ':') break;
    q++;
    while (q < n && src[q] === ' ') q++;
    if (q < n && src[q] === '\n') {
      q++;
      while (q < n && (src[q] === ' ' || src[q] === '\t')) q++;
    }
    if (q >= n) break;
    const d = parseDest(src, q);
    if (!d) break;
    q = d.next;
    let title = null;
    let endPos = q;
    let r = q, ws = 0;
    while (r < n && src[r] === ' ') { r++; ws++; }
    if (ws > 0 && r < n && (src[r] === '"' || src[r] === "'" || src[r] === '(')) {
      const t = parseTitle(src, r);
      if (!t) break;
      let s2 = t.next;
      while (s2 < n && src[s2] === ' ') s2++;
      if (s2 < n && src[s2] !== '\n') break;
      title = t.title;
      endPos = s2;
    } else if (r < n && src[r] !== '\n') {
      break;
    } else {
      endPos = r;
      if (r < n && src[r] === '\n') {
        let r2 = r + 1;
        while (r2 < n && (src[r2] === ' ' || src[r2] === '\t')) r2++;
        if (r2 < n && (src[r2] === '"' || src[r2] === "'" || src[r2] === '(')) {
          const t = parseTitle(src, r2);
          if (t) {
            let s2 = t.next;
            while (s2 < n && src[s2] === ' ') s2++;
            if (s2 >= n || src[s2] === '\n') { title = t.title; endPos = s2; }
          }
        }
      }
    }
    if (!refs.has(key)) refs.set(key, { href: d.dest, title });
    pos = endPos;
  }
  let rest = src.slice(pos);
  rest = rest.replace(/^\n+/, '');
  return rest;
}

function parseTableDelim(s) {
  let t = s.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  if (t.trim() === '') return null;
  const cells = t.split('|');
  const align = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    if (c.startsWith(':') && c.endsWith(':') && c.length > 1) align.push('center');
    else if (c.endsWith(':')) align.push('right');
    else if (c.startsWith(':')) align.push('left');
    else align.push(null);
  }
  return align;
}

function splitTableRow(s) {
  const cells = [];
  let cur = '', i = 0, n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n) { cur += s[i] + s[i + 1]; i += 2; continue; }
    if (c === '`') {
      let j = i;
      while (j < n && s[j] === '`') j++;
      const run = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (s[k] === '`') {
          let m = k;
          while (m < n && s[m] === '`') m++;
          if (m - k === run) { found = k; break; }
          k = m;
        } else k++;
      }
      if (found === -1) { cur += s.slice(i, j); i = j; }
      else { cur += s.slice(i, found + run); i = found + run; }
      continue;
    }
    if (c === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur);
  const trimmedStart = s.replace(/^[ \t]+/, '');
  const trimmedEnd = s.replace(/[ \t]+$/, '');
  if (trimmedStart.startsWith('|')) cells.shift();
  if (trimmedEnd.endsWith('|')) {
    let bs = 0;
    for (let k = trimmedEnd.length - 2; k >= 0 && trimmedEnd[k] === '\\'; k--) bs++;
    if (bs % 2 === 0) cells.pop();
  }
  return cells.map(x => x.trim().replace(/\\\|/g, '|'));
}

// Gather the lines of a blockquote starting at lines[j]. Returns {sub, next}.
// A plain blank line (no '>' marker) ENDS the quote; a '>' line, even with
// empty/whitespace content, is part of it. All gathered lines are consumed.
function gatherQuote(lines, j, hi) {
  const sub = [];
  let k = j;
  let paraOpen = false;
  let prevLazy = false;
  // A fenced code block open in the quote content: its lines are not
  // paragraph text, and a line without '>' cannot lazily continue it —
  // it ends the fence (and the quote).
  let inFence = null;
  while (k < hi) {
    const line = lines[k];
    const inf = firstNonWs(line);
    if (inf.col <= 3 && inf.idx < line.s.length && line.s[inf.idx] === '>') {
      const gtCol = line.c + inf.col; // absolute column of '>'
      let idx = inf.idx + 1, col = gtCol + 1, pend = 0;
      if (idx < line.s.length) {
        if (line.s[idx] === ' ') { idx++; col++; }
        else if (line.s[idx] === '\t') {
          const w = 4 - (col % 4);
          pend = w - 1;
          idx++;
          col++;
        }
      }
      const content = pend > 0 ? ' '.repeat(pend) + line.s.slice(idx) : line.s.slice(idx);
      const subLine = L(content, col);
      sub.push(subLine);
      if (inFence) {
        const cinf = firstNonWs(L(content, 0));
        if (cinf.col <= 3 && isFenceClose(content.slice(cinf.idx), inFence)) inFence = null;
        paraOpen = false;
      } else {
        const cinf = firstNonWs(L(content, 0));
        if (cinf.col <= 3) {
          const f = matchFence(content.slice(cinf.idx));
          if (f) inFence = f;
        }
        paraOpen = content !== '' && deepIsPara(content);
      }
      prevLazy = false;
      k++;
      continue;
    }
    if (isBlankLine(line)) break;
    if (inFence) break;
    const cnt = restOf(line, inf);
    // Lazy continuation: a line indented >=4 cannot start a block that
    // interrupts a paragraph (it would be indented code), so it is text.
    // Any list marker (even an empty one) ends the quote: it starts a new
    // item at the outer level, it is not a lazy continuation.
    if (paraOpen && (inf.col >= 4 || (!startsBlock(cnt) && !matchListMarker(cnt, 0)))) {
      let subLine = line;
      if (inf.col >= 4) {
        // A lazy line indented >=4 has exactly 4 columns stripped. The
        // result is paragraph text (marked lz) so the sub-parse does not
        // re-read it as a block (e.g. '- bar' must not become a list).
        const c4 = consumeIndent(line, line.c + 4);
        if (c4.ok) subLine = restLine(line, c4);
      } else if (prevLazy && setextLevel(cnt) === 1) {
        // A lazy setext-underline-shaped line whose predecessor was also lazy
        // gets its indent padded to 4 columns (it must not read as a setext
        // underline when the quote content is parsed).
        subLine = L(' '.repeat(4 - inf.col) + line.s, 0);
      }
      subLine.lz = true;
      sub.push(subLine);
      prevLazy = true;
      k++;
      continue;
    }
    break;
  }
  return { sub, next: Math.max(k, j + 1) };
}

// Gather the lines of one list item. firstContent is the item's first line
// content as a line object. contentIndentAbs is the absolute column of the
// item content. Returns {sub, next, blankBetween}.
function gatherItem(lines, j, hi, contentIndentAbs, firstContent) {
  const sub = [firstContent];
  let k = j + 1;
  let paraOpen = firstContent.s !== '' && deepIsPara(firstContent.s);
  let hasContent = firstContent.s !== '';
  // Relative content indent (columns from the marker line's own start).
  // Used as a fallback when absolute columns disagree across lines whose
  // container markers sit at different columns (e.g. '>>' vs '> >').
  const relContentIndent = contentIndentAbs - lines[j].c;
  while (k < hi) {
    const line = lines[k];
    if (isBlankLine(line)) {
      // An item that is still empty ends at a blank line; its content
      // cannot resume on a later line.
      if (!hasContent) break;
      const c0 = consumeIndent(line, contentIndentAbs);
      sub.push(c0.ok ? restLine(line, c0) : L('', line.c));
      paraOpen = false;
      k++;
      continue;
    }
    // A line belongs to the item when its indent relative to its own line
    // start reaches the item's relative content indent. Absolute columns
    // disagree across lines whose container markers sit at different
    // columns (e.g. '>>' vs '> >'), so relative indent is the reliable
    // measure (cm-259: 4 >= 4 in; cm-260: 0 < 2 out).
    const inf = firstNonWs(line);
    if (inf.col >= relContentIndent) {
      const c = consumeIndent(line, line.c + relContentIndent);
      const subLine = c.ok ? restLine(line, c) : line;
      sub.push(subLine);
      if (subLine.s !== '') { hasContent = true; paraOpen = deepIsPara(subLine.s); }
      k++;
      continue;
    }
    const cnt = restOf(line, inf);
    if (paraOpen && (inf.col >= 4 || (!startsBlock(cnt) && !matchListMarker(cnt, 0)))) {
      let subLine = line;
      if (inf.col >= 4) {
        const c4 = consumeIndent(line, line.c + 4);
        if (c4.ok) subLine = restLine(line, c4);
      }
      subLine.lz = true;
      sub.push(subLine);
      k++;
      continue;
    }
    break;
  }
  let last = -1;
  for (let t = sub.length - 1; t >= 0; t--) { if (!isBlankLine(sub[t])) { last = t; break; } }
  const trimmed = sub.slice(0, last + 1);
  return { sub: trimmed, next: Math.max(k - (sub.length - 1 - last), j + 1) };
}

function parseList(lines, i, hi, refs) {
  const firstLine = lines[i];
  const inf0 = firstNonWs(firstLine);
  const m0 = matchListMarker(restOf(firstLine, inf0), firstLine.c + inf0.col);
  const listIndent = inf0.col;
  const ordered = m0.ordered;
  const bullet = m0.bullet;
  const delim = m0.delim;
  const items = [];
  let loose = false;
  let pendingBlank = false;
  let firstBlank = -1;
  let j = i;
  while (j < hi) {
    const line = lines[j];
    if (isBlankLine(line)) {
      if (!pendingBlank) firstBlank = j;
      pendingBlank = true; j++; continue;
    }
    const inf = firstNonWs(line);
    if (inf.col > listIndent + 3) break;
    const cnt = restOf(line, inf);
    if (isThematic(cnt)) break; // a thematic break ends the list
    const m = matchListMarker(cnt, line.c + inf.col);
    if (!m) break;
    if (m.ordered !== ordered) break;
    if (!ordered && m.bullet !== bullet) break;
    if (ordered && m.delim !== delim) break;
    if (items.length > 0 && pendingBlank) loose = true;
    pendingBlank = false;
    const g = gatherItem(lines, j, hi, line.c + inf.col + m.contentIndent, L(m.content, m.contentColAbs));
    const subBlocks = parseBlocks(g.sub, 0, g.sub.length, refs, false, true);
    if (subBlocks.blankGap) loose = true;
    items.push({ blocks: subBlocks });
    j = g.next;
  }
  // Blank lines that did not lead to another item are given back, so an
  // outer container still sees the gap (it may separate its own blocks).
  if (pendingBlank && firstBlank >= 0) j = firstBlank;
  return { block: { t: 'list', ordered, start: m0.start, tight: !loose, items }, next: j };
}

function parseBlocks(lines, lo, hi, refs, endsNl, inList) {
  const blocks = [];
  let i = lo;
  let para = [];
  // blankGap: two top-level blocks of THIS parse were separated by a blank
  // line. Scoped per parse call, so blank lines inside a nested list or
  // quote do not loosen an outer list.
  let sawBlank = false, blankGap = false;
  function addBlock(b) {
    if (sawBlank) { blankGap = true; sawBlank = false; }
    blocks.push(b);
  }
  function flushPara() {
    if (!para.length) return;
    const text = stripRefDefs(para, refs);
    if (text.length) addBlock({ t: 'p', text });
    para = [];
  }
  while (i < hi) {
    const line = lines[i];
    const info = firstNonWs(line);
    const content = restOf(line, info);
    if (content === '') {
      // A whitespace-only line is paragraph text (not a blank line) when it
      // is the last line and the input does not end with a newline. An
      // actually empty line is always blank.
      if (para.length && i === hi - 1 && !endsNl && line.s !== '') { para.push(line.s); i++; continue; }
      flushPara();
      if (blocks.length) sawBlank = true;
      i++; continue;
    }

    if (para.length) {
      if (info.col <= 3) {
        const st = setextLevel(content);
        if (st) {
          const text = stripRefDefs(para, refs).replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
          if (text.length) {
            addBlock({ t: 'h', level: st, text });
            para = [];
            i++;
            continue;
          }
          // Paragraph was only link reference definitions: the setext
          // line is plain paragraph text, not a heading underline.
          para.push(line.s);
          i++;
          continue;
        }
        if (para.length === 1) {
          const delim = parseTableDelim(content);
          if (delim) {
            const head = splitTableRow(para[0]);
            if (head.length !== delim.length) { para.push(line.s); i++; continue; }
            const rows = [];
            let j = i + 1;
            while (j < hi) {
              const rl = lines[j];
              // A whitespace-only line containing a tab is a table row
              // (empty cells), not the end of the table; a spaces-only or
              // empty line ends it.
              if (isBlankLine(rl) && rl.s.indexOf('\t') === -1) break;
              const rinfo = firstNonWs(rl);
              const rc = restOf(rl, rinfo);
              if (startsBlock(rc, inList)) break;
              rows.push(splitTableRow(rc));
              j++;
            }
            addBlock({ t: 'table', align: delim, head, rows });
            para = [];
            i = j;
            continue;
          }
        }
        if (startsBlock(content, inList)) { if (!line.lz) flushPara(); else { para.push(line.s); i++; continue; } }
        else { para.push(line.s); i++; continue; }
      } else {
        para.push(line.s); i++; continue;
      }
    }

    // indented code
    if (!para.length && info.col >= 4) {
      const codeLines = [];
      let j = i;
      while (j < hi) {
        const ln = lines[j];
        if (isBlankLine(ln)) {
          const c0 = consumeIndent(ln, ln.c + 4);
          codeLines.push(c0.ok ? restOf(ln, c0) : '');
          j++;
          continue;
        }
        const c = consumeIndent(ln, ln.c + 4);
        if (!c.ok) break;
        codeLines.push(restOf(ln, c));
        j++;
      }
      let last = -1;
      for (let t = codeLines.length - 1; t >= 0; t--) { if (codeLines[t] !== '') { last = t; break; } }
      const trimmed = codeLines.slice(0, last + 1);
      addBlock({ t: 'code', lang: null, text: trimmed.join('\n') + (trimmed.length ? '\n' : '') });
      i = j - (codeLines.length - 1 - last);
      continue;
    }

    const atx = matchAtx(content);
    if (atx) { addBlock({ t: 'h', level: atx.level, text: atx.text }); i++; continue; }

    const fence = matchFence(content);
    if (fence) {
      const fenceIndent = info.col;
      const codeLines = [];
      let j = i + 1;
      while (j < hi) {
        const ln = lines[j];
        const inf = firstNonWs(ln);
        if (inf.col <= 3 && isFenceClose(restOf(ln, inf), fence)) { j++; break; }
        // dedent content lines by the opening fence's indent
        const dc = consumeIndent(ln, ln.c + fenceIndent);
        let codeLine = dc.ok ? restOf(ln, dc) : restOf(ln, inf);
        // A leading tab in fenced-code content expands to spaces when the
        // line went through container stripping (sub-line c > 0): the tab
        // was exposed by the container indent, so its width is fixed by
        // its column. At top level (c == 0) the tab stays verbatim.
        if (ln.c > 0) {
          let col = dc.ok ? dc.col : ln.c;
          while (codeLine.charCodeAt(0) === 9) {
            const w = 4 - (col % 4);
            codeLine = ' '.repeat(w) + codeLine.slice(1);
            col += w;
          }
        }
        codeLines.push(codeLine);
        j++;
      }
      let lang = null;
      const infoStr = fence.info.trim();
      if (infoStr !== '') lang = unescapeStr(infoStr.split(/\s+/)[0]);
      // A fenced code block drops exactly one trailing blank line.
      if (codeLines.length && codeLines[codeLines.length - 1] === '') codeLines.pop();
      addBlock({ t: 'code', lang, text: codeLines.join('\n') + (codeLines.length ? '\n' : '') });
      i = j;
      continue;
    }

    if (isThematic(content)) { addBlock({ t: 'hr' }); i++; continue; }

    const ht = htmlBlockType(content);
    if (ht) {
      const htmlLines = [line.s];
      let j = i + 1;
      let ended = htmlBlockEnd(ht, content);
      let stoppedAtBlank = false;
      // Types 1-5 end only at their end tag (blank lines are content);
      // types 6-7 end at a blank line.
      while (j < hi && !ended) {
        const ln = lines[j];
        if (ht >= 6 && isBlankLine(ln)) { stoppedAtBlank = true; break; }
        htmlLines.push(ln.s);
        if (htmlBlockEnd(ht, ln.s)) ended = true;
        j++;
      }
      let text = htmlLines.join('\n');
      let trailingNl = false;
      if (stoppedAtBlank) trailingNl = false;
      else if (j >= hi) trailingNl = endsNl;
      else trailingNl = !isBlankLine(lines[j]);
      if (trailingNl) text += '\n';
      addBlock({ t: 'html', text });
      i = j;
      continue;
    }

    if (content[0] === '>') {
      const g = gatherQuote(lines, i, hi);
      addBlock({ t: 'quote', blocks: parseBlocks(g.sub, 0, g.sub.length, refs, false, inList) });
      i = g.next;
      continue;
    }

    const lm = matchListMarker(content, line.c + info.col);
    if (lm) {
      const res = parseList(lines, i, hi, refs);
      addBlock(res.block);
      i = res.next;
      continue;
    }

    // A new paragraph starting after a blank line marks a blank gap even
    // if it turns out to be only link reference definitions (no block).
    if (sawBlank) { blankGap = true; sawBlank = false; }
    para.push(line.s);
    i++;
  }
  flushPara();
  blocks.blankGap = blankGap;
  return blocks;
}

// ---------------- rendering ----------------

function renderListItem(item, tight, refs) {
  let html = '';
  const blocks = item.blocks;
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b.t === 'p') {
      let text = b.text;
      let task = '';
      if (bi === 0) {
        const m = text.match(/^\[([ xX])\]([ \t]|$)/);
        if (m) {
          task = m[1] === ' ' ? '<input disabled="" type="checkbox">'
                              : '<input checked="" disabled="" type="checkbox">';
          text = text.slice(3);
        }
      }
      if (tight) html += task + inlineParse(text, refs);
      else html += '<p>' + task + inlineParse(text, refs) + '</p>\n';
    } else {
      html += renderBlocks([b], refs);
    }
  }
  return html;
}

function renderBlocks(blocks, refs) {
  let html = '';
  for (const b of blocks) {
    switch (b.t) {
      case 'p':
        html += '<p>' + inlineParse(b.text, refs) + '</p>\n';
        break;
      case 'h':
        html += '<h' + b.level + '>' + inlineParse(b.text, refs) + '</h' + b.level + '>\n';
        break;
      case 'code':
        html += '<pre><code' + (b.lang ? ' class="language-' + escapeText(b.lang) + '"' : '') + '>' +
                escapeRaw(b.text) + '</code></pre>\n';
        break;
      case 'hr':
        html += '<hr>\n';
        break;
      case 'quote':
        html += '<blockquote>\n' + renderBlocks(b.blocks, refs) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        html += '<' + tag + (b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n';
        for (const item of b.items) {
          html += '<li>' + renderListItem(item, b.tight, refs) + '</li>\n';
        }
        html += '</' + tag + '>\n';
        break;
      }
      case 'html':
        html += b.text;
        break;
      case 'table': {
        const ncols = b.align.length;
        html += '<table>\n<thead>\n<tr>\n';
        for (let ci = 0; ci < ncols; ci++) {
          const a = b.align[ci];
          const cell = ci < b.head.length ? b.head[ci] : '';
          html += '<th' + (a ? ' align="' + a + '"' : '') + '>' + inlineParse(cell, refs) + '</th>\n';
        }
        html += '</tr>\n</thead>\n';
        if (b.rows.length > 0) {
          html += '<tbody>';
          for (const row of b.rows) {
            html += '<tr>\n';
            for (let ci = 0; ci < ncols; ci++) {
              const a = b.align[ci];
              const cell = ci < row.length ? row[ci] : '';
              html += '<td' + (a ? ' align="' + a + '"' : '') + '>' + inlineParse(cell, refs) + '</td>\n';
            }
            html += '</tr>\n';
          }
          html += '</tbody>';
        }
        html += '</table>\n';
        break;
      }
    }
  }
  return html;
}

let INPUT_ENDS_NL = false;
// marked's lexer inLink: set by a raw <a ...> tag, cleared by </a>, and
// PERSISTS across paragraphs until cleared (it suppresses bare-URL/email
// autolinks). Reset at the start of every parse().
let IN_LINK = false;

export function parse(markdown) {
  const s = markdown.replace(/\r\n?/g, '\n');
  INPUT_ENDS_NL = s.endsWith('\n');
  IN_LINK = false;
  const raw = s.split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  const lines = raw.map(x => L(x, 0));
  const refs = new Map();
  const blocks = parseBlocks(lines, 0, lines.length, refs, INPUT_ENDS_NL);
  return renderBlocks(blocks, refs);
}
