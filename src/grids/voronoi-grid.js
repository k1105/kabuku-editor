import { createCell } from '../core/cell.js';

export const VoronoiGrid = {
  name: 'VoronoiGrid',

  getParamDefs() {
    return [
      { key: 'count', label: 'Count', min: 10, max: 800, default: 200, step: 5 },
      { key: 'seed', label: 'Seed', min: 0, max: 999, default: 42, step: 1 },
      { key: 'relaxation', label: 'Relaxation', min: 0, max: 10, default: 2, step: 1 },
    ];
  },

  generateCells(width, height, params) {
    const { count = 200, seed = 42, relaxation = 2 } = params;

    // Generate seed points with seeded RNG
    let points = [];
    const rng = mulberry32(seed);
    for (let i = 0; i < count; i++) {
      points.push({ x: rng() * width, y: rng() * height });
    }

    // Lloyd relaxation
    for (let iter = 0; iter < relaxation; iter++) {
      const voronoi = computeVoronoi(points, width, height);
      points = voronoi.map(cell => {
        if (cell.vertices.length === 0) return cell.site;
        let cx = 0, cy = 0;
        for (const v of cell.vertices) { cx += v.x; cy += v.y; }
        return { x: cx / cell.vertices.length, y: cy / cell.vertices.length };
      });
    }

    // Final Voronoi computation
    const voronoi = computeVoronoi(points, width, height);
    const cells = [];

    for (const cell of voronoi) {
      if (cell.vertices.length < 3) continue;
      const path = new Path2D();
      path.moveTo(cell.vertices[0].x, cell.vertices[0].y);
      for (let i = 1; i < cell.vertices.length; i++) {
        path.lineTo(cell.vertices[i].x, cell.vertices[i].y);
      }
      path.closePath();
      cells.push(createCell({ path, center: cell.site }));
    }

    return cells;
  },
};

// Simple seeded PRNG (mulberry32)
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Fortune's algorithm is complex; use a scanline-based Voronoi via brute-force
// sampling for simplicity and correctness. For N points on a WxH canvas,
// we assign each pixel to its nearest site, then extract polygon boundaries.
// However, that's too slow for large canvases. Instead, we use a geometric
// approach: compute Delaunay triangulation, then derive Voronoi from it.

function computeVoronoi(points, width, height) {
  // Use a simple incremental approach for Delaunay, then dual for Voronoi
  const delaunay = bowyerWatson(points, width, height);
  return voronoiFromDelaunay(delaunay, points, width, height);
}

// Bowyer-Watson Delaunay triangulation
function bowyerWatson(points, width, height) {
  // Super-triangle that contains all points
  const margin = Math.max(width, height) * 10;
  const st = [
    { x: -margin, y: -margin },
    { x: width + margin * 2, y: -margin },
    { x: width / 2, y: height + margin * 2 },
  ];

  let triangles = [{ v: [0, 1, 2] }];
  const allPts = [...st, ...points];

  for (let i = 3; i < allPts.length; i++) {
    const p = allPts[i];
    const bad = [];
    for (let t = 0; t < triangles.length; t++) {
      const tri = triangles[t];
      if (inCircumcircle(p, allPts[tri.v[0]], allPts[tri.v[1]], allPts[tri.v[2]])) {
        bad.push(t);
      }
    }

    // Find boundary polygon of bad triangles
    const edges = [];
    for (const t of bad) {
      const tri = triangles[t];
      for (let e = 0; e < 3; e++) {
        const a = tri.v[e], b = tri.v[(e + 1) % 3];
        // Check if edge is shared with another bad triangle
        let shared = false;
        for (const t2 of bad) {
          if (t2 === t) continue;
          const tri2 = triangles[t2];
          if (hasEdge(tri2, a, b)) { shared = true; break; }
        }
        if (!shared) edges.push([a, b]);
      }
    }

    // Remove bad triangles (in reverse order)
    bad.sort((a, b) => b - a);
    for (const t of bad) triangles.splice(t, 1);

    // Create new triangles
    for (const [a, b] of edges) {
      triangles.push({ v: [a, b, i] });
    }
  }

  // Remove triangles that reference super-triangle vertices
  triangles = triangles.filter(tri =>
    tri.v[0] >= 3 && tri.v[1] >= 3 && tri.v[2] >= 3
  );

  // Remap indices (subtract 3 for super-triangle offset)
  return triangles.map(tri => ({
    v: [tri.v[0] - 3, tri.v[1] - 3, tri.v[2] - 3],
  }));
}

function hasEdge(tri, a, b) {
  for (let e = 0; e < 3; e++) {
    const ea = tri.v[e], eb = tri.v[(e + 1) % 3];
    if ((ea === a && eb === b) || (ea === b && eb === a)) return true;
  }
  return false;
}

function inCircumcircle(p, a, b, c) {
  const ax = a.x - p.x, ay = a.y - p.y;
  const bx = b.x - p.x, by = b.y - p.y;
  const cx = c.x - p.x, cy = c.y - p.y;
  const det = (ax * ax + ay * ay) * (bx * cy - cx * by)
            - (bx * bx + by * by) * (ax * cy - cx * ay)
            + (cx * cx + cy * cy) * (ax * by - bx * ay);
  return det > 0;
}

function circumcenter(a, b, c) {
  const D = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(D) < 1e-10) return null;
  const ux = ((a.x * a.x + a.y * a.y) * (b.y - c.y) +
              (b.x * b.x + b.y * b.y) * (c.y - a.y) +
              (c.x * c.x + c.y * c.y) * (a.y - b.y)) / D;
  const uy = ((a.x * a.x + a.y * a.y) * (c.x - b.x) +
              (b.x * b.x + b.y * b.y) * (a.x - c.x) +
              (c.x * c.x + c.y * c.y) * (b.x - a.x)) / D;
  return { x: ux, y: uy };
}

// Derive Voronoi cells from Delaunay triangulation
function voronoiFromDelaunay(triangles, points, width, height) {
  const n = points.length;

  // For each point, find all triangles it belongs to
  const pointTriangles = new Array(n);
  for (let i = 0; i < n; i++) pointTriangles[i] = [];

  for (let t = 0; t < triangles.length; t++) {
    const tri = triangles[t];
    pointTriangles[tri.v[0]].push(t);
    pointTriangles[tri.v[1]].push(t);
    pointTriangles[tri.v[2]].push(t);
  }

  // Compute circumcenters
  const centers = triangles.map(tri =>
    circumcenter(points[tri.v[0]], points[tri.v[1]], points[tri.v[2]])
  );

  const cells = [];
  for (let i = 0; i < n; i++) {
    const tris = pointTriangles[i];
    if (tris.length < 3) {
      cells.push({ site: points[i], vertices: [] });
      continue;
    }

    // Get circumcenters, filter nulls
    const verts = [];
    for (const t of tris) {
      if (centers[t]) verts.push(centers[t]);
    }

    if (verts.length < 3) {
      cells.push({ site: points[i], vertices: [] });
      continue;
    }

    // Sort vertices by angle around the site
    const sx = points[i].x, sy = points[i].y;
    verts.sort((a, b) =>
      Math.atan2(a.y - sy, a.x - sx) - Math.atan2(b.y - sy, b.x - sx)
    );

    // Clip to canvas bounds
    const clipped = clipPolygon(verts, width, height);
    cells.push({ site: points[i], vertices: clipped });
  }

  return cells;
}

// Sutherland-Hodgman polygon clipping to [0,0,width,height]
function clipPolygon(vertices, width, height) {
  let output = vertices;

  const edges = [
    { test: p => p.x >= 0, intersect: (a, b) => ({ x: 0, y: a.y + (b.y - a.y) * (-a.x) / (b.x - a.x) }) },
    { test: p => p.x <= width, intersect: (a, b) => ({ x: width, y: a.y + (b.y - a.y) * (width - a.x) / (b.x - a.x) }) },
    { test: p => p.y >= 0, intersect: (a, b) => ({ x: a.x + (b.x - a.x) * (-a.y) / (b.y - a.y), y: 0 }) },
    { test: p => p.y <= height, intersect: (a, b) => ({ x: a.x + (b.x - a.x) * (height - a.y) / (b.y - a.y), y: height }) },
  ];

  for (const edge of edges) {
    if (output.length === 0) return [];
    const input = output;
    output = [];

    for (let i = 0; i < input.length; i++) {
      const curr = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const currInside = edge.test(curr);
      const prevInside = edge.test(prev);

      if (currInside) {
        if (!prevInside) output.push(edge.intersect(prev, curr));
        output.push(curr);
      } else if (prevInside) {
        output.push(edge.intersect(prev, curr));
      }
    }
  }

  return output;
}
