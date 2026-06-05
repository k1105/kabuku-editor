/**
 * KanjiVG stroke-path editing support.
 *
 * KanjiVG strokes are open cubic-bezier centerlines. To let the user drag the
 * anchor points and bezier handles, we parse each path `d` string into an
 * editable list of cubic anchors (in KanjiVG's own 109-unit space), let the UI
 * mutate them, then serialize back to `d` strings for re-stroking.
 *
 * Anchor shape: { pt:{x,y}, cIn:{x,y}|null, cOut:{x,y}|null, mode }
 *   - cOut is the control point leaving this anchor (toward the next anchor)
 *   - cIn  is the control point entering this anchor (from the previous one)
 *   - mode: 'smooth' (cIn/cOut kept collinear through pt) | 'broken' (independent)
 * A subpath is { anchors: Anchor[], closed: boolean }.
 *
 * Only the command subset KanjiVG actually uses is supported (M/L/H/V/C/S, abs
 * and relative, plus Z). Unknown commands throw so callers can fall back to the
 * plain rasterized base instead of a broken editor.
 */

// Matches a command letter or a number (incl. decimals / exponents). KanjiVG
// numbers can run together ("12.25,10.75c2.62,0.66") so we tokenize loosely.
const TOKEN_RE = /[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

// Cross-product threshold (in 109-space units) below which cIn/pt/cOut count as
// collinear → the anchor is treated as 'smooth' on load.
const COLLINEAR_EPS = 0.8;

function isCmd(t) {
  return /^[a-zA-Z]$/.test(t);
}

function collinear(a, b, c) {
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(cross) < COLLINEAR_EPS;
}

function newAnchor(x, y) {
  return { pt: { x, y }, cIn: null, cOut: null, mode: 'broken' };
}

/** Parse one `d` string into one or more subpaths of cubic anchors. */
function parsePath(d) {
  const tokens = d.match(TOKEN_RE) || [];
  let i = 0;
  const num = () => parseFloat(tokens[i++]);

  const subpaths = [];
  let cur = null;        // current subpath
  let px = 0, py = 0;    // current point
  let sx = 0, sy = 0;    // subpath start (for Z)
  let lastCmd = '';
  let lastCtrl = null;   // 2nd control of the previous C/S (abs), for S reflection

  while (i < tokens.length) {
    let cmd;
    if (isCmd(tokens[i])) {
      cmd = tokens[i++];
    } else {
      // Implicit repeat of the previous command; after M/m the repeat is L/l.
      cmd = lastCmd === 'M' ? 'L' : lastCmd === 'm' ? 'l' : lastCmd;
      if (!cmd) throw new Error('Path starts without a command');
    }
    lastCmd = cmd;
    const rel = cmd >= 'a';
    const C = cmd.toUpperCase();

    if (C === 'M') {
      let x = num(), y = num();
      if (rel) { x += px; y += py; }
      px = sx = x; py = sy = y;
      cur = { anchors: [newAnchor(x, y)], closed: false };
      subpaths.push(cur);
      lastCtrl = null;
    } else if (C === 'L' || C === 'H' || C === 'V') {
      let x = px, y = py;
      if (C === 'H') { x = rel ? px + num() : num(); }
      else if (C === 'V') { y = rel ? py + num() : num(); }
      else { x = num(); y = num(); if (rel) { x += px; y += py; } }
      cur.anchors.push(newAnchor(x, y));
      px = x; py = y; lastCtrl = null;
    } else if (C === 'C') {
      let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
      if (rel) { x1 += px; y1 += py; x2 += px; y2 += py; x += px; y += py; }
      cur.anchors[cur.anchors.length - 1].cOut = { x: x1, y: y1 };
      const a = newAnchor(x, y); a.cIn = { x: x2, y: y2 };
      cur.anchors.push(a);
      px = x; py = y; lastCtrl = { x: x2, y: y2 };
    } else if (C === 'S') {
      let x2 = num(), y2 = num(), x = num(), y = num();
      if (rel) { x2 += px; y2 += py; x += px; y += py; }
      // First control = reflection of the previous control through the current
      // point (or the current point itself if the previous command wasn't cubic).
      const x1 = lastCtrl ? 2 * px - lastCtrl.x : px;
      const y1 = lastCtrl ? 2 * py - lastCtrl.y : py;
      cur.anchors[cur.anchors.length - 1].cOut = { x: x1, y: y1 };
      const a = newAnchor(x, y); a.cIn = { x: x2, y: y2 };
      cur.anchors.push(a);
      px = x; py = y; lastCtrl = { x: x2, y: y2 };
    } else if (C === 'Z') {
      if (cur) cur.closed = true;
      px = sx; py = sy; lastCtrl = null;
    } else {
      throw new Error('Unsupported path command: ' + cmd);
    }
  }

  // Drop degenerate single-point subpaths (a lone M).
  return subpaths.filter((sp) => sp.anchors.length > 1);
}

/**
 * Parse an array of `d` strings into a flat list of editable subpaths. Throws
 * on any unsupported command.
 */
export function parsePaths(dStrings) {
  const out = [];
  for (const d of dStrings) {
    for (const sp of parsePath(d)) {
      for (const a of sp.anchors) {
        if (a.cIn && a.cOut) a.mode = collinear(a.cIn, a.pt, a.cOut) ? 'smooth' : 'broken';
      }
      out.push(sp);
    }
  }
  return out;
}

function fmt(n) {
  return (Math.round(n * 1000) / 1000).toString();
}

function serializeSubpath(sp) {
  const a = sp.anchors;
  let d = `M${fmt(a[0].pt.x)},${fmt(a[0].pt.y)}`;
  for (let i = 1; i < a.length; i++) {
    const p = a[i - 1], q = a[i];
    if (p.cOut && q.cIn) {
      d += `C${fmt(p.cOut.x)},${fmt(p.cOut.y)} ${fmt(q.cIn.x)},${fmt(q.cIn.y)} ${fmt(q.pt.x)},${fmt(q.pt.y)}`;
    } else {
      d += `L${fmt(q.pt.x)},${fmt(q.pt.y)}`;
    }
  }
  if (sp.closed) d += 'Z';
  return d;
}

/** Serialize editable subpaths back to one `d` string per subpath. */
export function serializePaths(subpaths) {
  return subpaths.map(serializeSubpath);
}

/**
 * Move one handle of an anchor, enforcing the anchor's mode. When the anchor is
 * 'smooth' and has both handles, the opposite handle is rotated to stay
 * collinear through the point while keeping its own length.
 *
 * @param {object} anchor  the anchor being edited
 * @param {'cIn'|'cOut'} which  which handle was dragged
 * @param {{x,y}} pos  new absolute position of the dragged handle (109-space)
 */
export function moveHandle(anchor, which, pos) {
  anchor[which] = { x: pos.x, y: pos.y };
  if (anchor.mode !== 'smooth') return;
  const other = which === 'cIn' ? 'cOut' : 'cIn';
  if (!anchor[other]) return;
  const { pt } = anchor;
  const dx = pos.x - pt.x, dy = pos.y - pt.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  // Preserve the opposite handle's current length, point it opposite.
  const oLen = Math.hypot(anchor[other].x - pt.x, anchor[other].y - pt.y);
  anchor[other] = { x: pt.x - (dx / len) * oLen, y: pt.y - (dy / len) * oLen };
}

/** Move an anchor point, dragging its handles along by the same delta. */
export function moveAnchor(anchor, pos) {
  const dx = pos.x - anchor.pt.x, dy = pos.y - anchor.pt.y;
  anchor.pt = { x: pos.x, y: pos.y };
  if (anchor.cIn) anchor.cIn = { x: anchor.cIn.x + dx, y: anchor.cIn.y + dy };
  if (anchor.cOut) anchor.cOut = { x: anchor.cOut.x + dx, y: anchor.cOut.y + dy };
}
