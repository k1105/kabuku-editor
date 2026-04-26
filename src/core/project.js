import { getAllGrids } from '../grids/grid-plugin.js';

const STORAGE_KEY = 'kabuku_project';

export const DEFAULT_FONT_METRICS = {
  ascender: 0.05,
  xHeight: 0.30,
  baseline: 0.80,
  descender: 0.95,
};

export const DEFAULT_FONT_INFO = {
  familyName: 'Kabuku',
  styleName: 'Regular',
  version: '1.000',
  copyright: '',
};

const DEFAULT_GLOBAL = {
  stretchAngle: 0,
  stretchAmount: 0,
  baseGap: 20,
  gapDirectionWeight: 1,
  metaballStrength: 1,
  metaballRadius: 8,
  gridDefaults: {},
  defaultLayers: [
    { gridName: 'FibonacciGrid', gridParams: { count: 1000, scale: 20, dotRadius: 14, rotation: 228 }, name: 'FibonacciGrid' },
  ],
  fontMetrics: { ...DEFAULT_FONT_METRICS },
  fontInfo: { ...DEFAULT_FONT_INFO },
};

export const ANIMATED_PARAM_KEYS = [
  'stretchAngle',
  'stretchAmount',
  'baseGap',
  'gapDirectionWeight',
  'metaballRadius',
  'fontSize',
  'textBoxWidth',
  'kerning',
  'lineHeight',
  'cameraX',
  'cameraY',
  'cameraDistance',
];

export const DEFAULT_ANIMATION_BASE_VALUES = {
  stretchAngle: 0,
  stretchAmount: 0,
  baseGap: 0,
  gapDirectionWeight: 0,
  metaballRadius: 8,
  fontSize: 64,
  textBoxWidth: 800,
  kerning: 0,
  lineHeight: 1.5,
  cameraX: 0,
  cameraY: 0,
  cameraDistance: 1,
};

function initialTracks(baseValues) {
  const out = {};
  for (const key of ANIMATED_PARAM_KEYS) {
    out[key] = [{ time: 0, value: baseValues[key], easing: 'linear' }];
  }
  return out;
}

export function createDefaultAnimation() {
  const baseValues = { ...DEFAULT_ANIMATION_BASE_VALUES };
  return {
    duration: 5,
    fps: 30,
    text: '',
    writingMode: 'horizontal',
    tracks: initialTracks(baseValues),
    baseValues,
  };
}

export const DEFAULT_ANIMATION = createDefaultAnimation();

export const DEFAULT_LAYER = {
  gridName: 'FibonacciGrid',
  gridParams: { count: 500, scale: 10, dotRadius: 7, rotation: 228 },
};

export const DEFAULT_TRANSFORM = {
  baseGap: 20,
  gapDirectionWeight: 1,
  metaballStrength: 1,
  metaballRadius: 8,
};

/** Build gridDefaults from registered grid plugins' getParamDefs() */
export function buildGridDefaults() {
  const defaults = {};
  for (const grid of getAllGrids()) {
    const params = {};
    for (const def of grid.getParamDefs()) {
      params[def.key] = def.default;
    }
    defaults[grid.name] = params;
  }
  return defaults;
}

/** Find the most common value for a key across an array of objects */
function mostCommonValue(objects, key) {
  const counts = new Map();
  for (const obj of objects) {
    if (obj && key in obj) {
      const v = obj[key];
      counts.set(v, (counts.get(v) || 0) + 1);
    }
  }
  if (counts.size === 0) return undefined;
  let best, bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) { best = v; bestCount = c; }
  }
  return best;
}

/** Migrate v1 → v2 (global-first params with overrides) */
function migrateV1toV2(data) {
  const chars = Object.values(data.characters || {});
  const g = data.global || {};

  const transformKeys = ['baseGap', 'gapDirectionWeight', 'metaballStrength', 'metaballRadius'];
  const allTransforms = chars.map(c => c.transform).filter(Boolean);
  for (const key of transformKeys) {
    const common = mostCommonValue(allTransforms, key);
    g[key] = common !== undefined ? common : DEFAULT_GLOBAL[key];
  }

  const gridParamsByType = {};
  for (const charData of chars) {
    for (const layer of charData.layers || []) {
      if (!layer.gridParams) continue;
      if (!gridParamsByType[layer.gridName]) gridParamsByType[layer.gridName] = [];
      gridParamsByType[layer.gridName].push(layer.gridParams);
    }
  }
  const pluginDefaults = buildGridDefaults();
  g.gridDefaults = {};
  for (const [gridName, paramsList] of Object.entries(gridParamsByType)) {
    const gd = { ...(pluginDefaults[gridName] || {}) };
    const allKeys = new Set(paramsList.flatMap(p => Object.keys(p)));
    for (const key of allKeys) {
      const common = mostCommonValue(paramsList, key);
      if (common !== undefined) gd[key] = common;
    }
    g.gridDefaults[gridName] = gd;
  }
  for (const [gridName, defaults] of Object.entries(pluginDefaults)) {
    if (!g.gridDefaults[gridName]) g.gridDefaults[gridName] = defaults;
  }

  data.global = g;

  for (const charData of chars) {
    if (charData.transform && !charData.transformOverrides) {
      const overrides = {};
      for (const [k, v] of Object.entries(charData.transform)) {
        if (g[k] !== undefined && g[k] !== v) {
          overrides[k] = v;
        }
      }
      charData.transformOverrides = Object.keys(overrides).length > 0 ? overrides : undefined;
      delete charData.transform;
    }
    if (charData.layers) {
      for (const layer of charData.layers) {
        if (layer.gridParams && !layer.gridParamOverrides) {
          const gd = g.gridDefaults[layer.gridName] || {};
          const overrides = {};
          for (const [k, v] of Object.entries(layer.gridParams)) {
            if (gd[k] !== v) overrides[k] = v;
          }
          layer.gridParamOverrides = Object.keys(overrides).length > 0 ? overrides : undefined;
          delete layer.gridParams;
        }
      }
    }
  }

  data.version = 2;
  return data;
}

/** Migrate v2 → v3 (layer structure moves to global, characters keep only overrides) */
function migrateV2toV3(data) {
  const chars = Object.values(data.characters || {});
  const g = data.global;

  // Derive defaultLayers from first character if empty
  if (!g.defaultLayers || g.defaultLayers.length === 0) {
    const firstChar = chars[0];
    if (firstChar?.layers && firstChar.layers.length > 0) {
      g.defaultLayers = firstChar.layers.map(l => ({
        gridName: l.gridName,
        gridParams: { ...(g.gridDefaults?.[l.gridName] || {}), ...(l.gridParamOverrides || {}) },
        name: l.name || l.gridName,
      }));
    } else {
      g.defaultLayers = [...DEFAULT_GLOBAL.defaultLayers];
    }
  }

  // Convert charData.layers → charData.layerOverrides
  for (const charData of chars) {
    if (charData.layers && !charData.layerOverrides) {
      charData.layerOverrides = charData.layers.map(l => ({
        gridParamOverrides: l.gridParamOverrides,
        cells: l.cells,
        opacity: l.opacity,
        visible: l.visible,
      }));
      delete charData.layers;
    }
  }

  data.version = 3;
  return data;
}

/** Migrate v3 → v4 (add animation data). */
function migrateV3toV4(data) {
  if (!data.animation) data.animation = createDefaultAnimation();
  data.version = 4;
  return data;
}

/** Migrate v4 → v5 (add font metrics to global). */
function migrateV4toV5(data) {
  if (!data.global.fontMetrics) {
    data.global.fontMetrics = { ...DEFAULT_FONT_METRICS };
  }
  data.version = 5;
  return data;
}

/** Migrate v5 → v6 (glyph reference size 512 → 1024; double saved cell coords + image offsets). */
function migrateV5toV6(data) {
  const SCALE = 2;
  for (const cd of Object.values(data.characters || {})) {
    for (const lo of cd.layerOverrides || []) {
      if (!lo?.cells) continue;
      for (const c of lo.cells) {
        if (c.center) {
          c.center = { x: c.center.x * SCALE, y: c.center.y * SCALE };
        }
      }
    }
    if (typeof cd.imageOffsetX === 'number') cd.imageOffsetX *= SCALE;
    if (typeof cd.imageOffsetY === 'number') cd.imageOffsetY *= SCALE;
  }
  data.version = 6;
  return data;
}

/** Migrate v6 → v7 (add font info to global). */
function migrateV6toV7(data) {
  if (!data.global.fontInfo) {
    data.global.fontInfo = { ...DEFAULT_FONT_INFO };
  }
  data.version = 7;
  return data;
}

function migrateProject(data) {
  if (!data.version || data.version < 2) {
    data = migrateV1toV2(data);
  }
  if (data.version < 3) {
    data = migrateV2toV3(data);
  }
  if (data.version < 4) {
    data = migrateV3toV4(data);
  }
  if (data.version < 5) {
    data = migrateV4toV5(data);
  }
  if (data.version < 6) {
    data = migrateV5toV6(data);
  }
  if (data.version < 7) {
    data = migrateV6toV7(data);
  }
  return data;
}

/**
 * Clean up: remove stale overrides that match global defaults.
 */
function consolidateOverrides(data) {
  const chars = Object.values(data.characters || {});
  if (chars.length === 0) return data;
  const g = data.global;

  // Consolidate transform overrides
  const transformKeys = ['baseGap', 'gapDirectionWeight', 'metaballStrength', 'metaballRadius'];
  for (const key of transformKeys) {
    const allOverrides = chars.filter(c => c.transformOverrides && key in c.transformOverrides);
    if (allOverrides.length === 0) continue;
    const vals = allOverrides.map(c => c.transformOverrides[key]);
    const charsWithout = chars.filter(c => !c.transformOverrides || !(key in c.transformOverrides));
    if (vals.length > 0 && vals.every(v => v === vals[0]) && charsWithout.length === 0) {
      g[key] = vals[0];
      for (const c of chars) {
        if (c.transformOverrides) {
          delete c.transformOverrides[key];
          if (Object.keys(c.transformOverrides).length === 0) c.transformOverrides = undefined;
        }
      }
    }
  }

  // Clean up grid param overrides that match global
  for (const charData of chars) {
    const overrides = charData.layerOverrides || [];
    for (let i = 0; i < overrides.length; i++) {
      const lo = overrides[i];
      if (!lo?.gridParamOverrides) continue;
      const globalLayer = g.defaultLayers?.[i];
      if (!globalLayer) continue;
      const gd = g.gridDefaults?.[globalLayer.gridName] || {};
      for (const [k, v] of Object.entries(lo.gridParamOverrides)) {
        if (gd[k] === v) delete lo.gridParamOverrides[k];
      }
      if (Object.keys(lo.gridParamOverrides).length === 0) lo.gridParamOverrides = undefined;
    }
  }

  return data;
}

export function loadProject() {
  try {
    const json = localStorage.getItem(STORAGE_KEY);
    if (json) {
      let data = JSON.parse(json);
      if (!data.global) data.global = { ...DEFAULT_GLOBAL, gridDefaults: buildGridDefaults() };
      data = migrateProject(data);
      data = consolidateOverrides(data);
      return data;
    }
  } catch (e) {
    console.warn('Failed to load project:', e);
  }
  return {
    characters: {},
    global: {
      ...DEFAULT_GLOBAL,
      gridDefaults: buildGridDefaults(),
      fontMetrics: { ...DEFAULT_FONT_METRICS },
      fontInfo: { ...DEFAULT_FONT_INFO },
    },
    animation: createDefaultAnimation(),
    version: 7,
  };
}

export function saveProject(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('Failed to save project:', e);
  }
}

export function getGlobal() {
  const g = loadProject().global;
  if (!g.gridDefaults || Object.keys(g.gridDefaults).length === 0) {
    g.gridDefaults = buildGridDefaults();
  }
  if (!g.defaultLayers || g.defaultLayers.length === 0) {
    g.defaultLayers = [...DEFAULT_GLOBAL.defaultLayers];
  }
  if (!g.fontMetrics) {
    g.fontMetrics = { ...DEFAULT_FONT_METRICS };
  }
  if (!g.fontInfo) {
    g.fontInfo = { ...DEFAULT_FONT_INFO };
  }
  return g;
}

/**
 * Resolve a single Unicode codepoint for a glyph from its charId.
 * Returns null when the id isn't a single character (e.g. "new_1") so the
 * caller can flag it for the user.
 */
export function resolveCodepoint(charId) {
  if (typeof charId !== 'string' || charId.length === 0) return null;
  const cp = charId.codePointAt(0);
  if (cp == null) return null;
  // Only treat as single-codepoint if the entire string is exactly that one
  // code point (handles surrogate pairs for non-BMP chars correctly).
  const expectedLen = cp > 0xFFFF ? 2 : 1;
  if (charId.length !== expectedLen) return null;
  return cp;
}

export function saveGlobal(global) {
  const project = loadProject();
  project.global = global;
  saveProject(project);
}

export function getAnimation() {
  const p = loadProject();
  if (!p.animation) p.animation = createDefaultAnimation();
  p.animation.baseValues = { ...DEFAULT_ANIMATION_BASE_VALUES, ...(p.animation.baseValues || {}) };
  // cameraDistance must be > 0; fix any zero/invalid values left over from earlier loads
  const cdTrack = p.animation.tracks?.cameraDistance;
  if (cdTrack) {
    for (const kf of cdTrack) {
      if (!(kf.value > 0)) kf.value = 1;
    }
  }
  if (!(p.animation.baseValues.cameraDistance > 0)) {
    p.animation.baseValues.cameraDistance = 1;
  }
  return p.animation;
}

export function saveAnimation(animation) {
  const project = loadProject();
  project.animation = animation;
  saveProject(project);
}

export function getCharacter(charId) {
  const project = loadProject();
  return project.characters[charId] || null;
}

export function saveCharacter(charId, charData) {
  const project = loadProject();
  project.characters[charId] = charData;
  saveProject(project);
}

export function getAllCharIds() {
  const project = loadProject();
  return Object.keys(project.characters);
}

export function deleteCharacter(charId) {
  const project = loadProject();
  if (!(charId in project.characters)) return false;
  delete project.characters[charId];
  saveProject(project);
  return true;
}

/**
 * Rename a character key. Preserves insertion order so the char strip UI
 * doesn't reshuffle when the user edits a name.
 * Returns { ok: true } on success or { ok: false, reason } on conflict/missing.
 */
export function renameCharacter(oldId, newId) {
  if (oldId === newId) return { ok: true };
  if (!newId) return { ok: false, reason: 'empty' };
  const project = loadProject();
  if (!(oldId in project.characters)) return { ok: false, reason: 'missing' };
  if (newId in project.characters) return { ok: false, reason: 'conflict' };
  const rebuilt = {};
  for (const [k, v] of Object.entries(project.characters)) {
    rebuilt[k === oldId ? newId : k] = v;
  }
  project.characters = rebuilt;
  saveProject(project);
  return { ok: true };
}

/**
 * Generate a unique charId based on a prefix. Used for empty-glyph creation
 * where the user hasn't picked a name yet.
 */
export function generateUniqueCharId(prefix = 'new') {
  const project = loadProject();
  if (!(prefix in project.characters)) return prefix;
  let i = 1;
  while (`${prefix}_${i}` in project.characters) i++;
  return `${prefix}_${i}`;
}

/**
 * Create an empty character entry (no image, no fill). Inherits global
 * layers/params via the standard layerOverrides=[] resolution path.
 */
export function createEmptyCharacter(charId) {
  const project = loadProject();
  if (charId in project.characters) return false;
  project.characters[charId] = { imagePath: '' };
  saveProject(project);
  return true;
}

/** Resolve transform: global defaults merged with per-character overrides */
export function resolveTransform(global, overrides) {
  return {
    baseGap: global.baseGap,
    gapDirectionWeight: global.gapDirectionWeight,
    metaballStrength: global.metaballStrength,
    metaballRadius: global.metaballRadius,
    stretchAngle: global.stretchAngle,
    stretchAmount: global.stretchAmount,
    ...overrides,
  };
}

/** Resolve grid params: global grid defaults merged with per-layer overrides */
export function resolveGridParams(global, gridName, overrides) {
  const gd = global.gridDefaults?.[gridName] || {};
  return { ...gd, ...overrides };
}

/** Compute overrides: returns only keys where resolved differs from global */
export function computeOverrides(resolved, globalDefaults) {
  const overrides = {};
  for (const [k, v] of Object.entries(resolved)) {
    if (globalDefaults[k] !== v) overrides[k] = v;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/**
 * Resolve character layers: build rendering data from global structure + character overrides.
 * Returns array of { gridName, name, resolvedParams, gridParamOverrides, cells, opacity, visible }
 */
export function resolveCharacterLayers(global, charData) {
  const overrides = charData?.layerOverrides || [];
  return (global.defaultLayers || []).map((globalLayer, i) => {
    const charOverride = overrides[i] || {};
    const gridParamOverrides = charOverride.gridParamOverrides || {};
    // Use the layer's own gridParams as base, not the per-type gridDefaults
    const resolvedParams = { ...globalLayer.gridParams, ...gridParamOverrides };
    return {
      gridName: globalLayer.gridName,
      name: globalLayer.name || globalLayer.gridName,
      resolvedParams,
      gridParamOverrides,
      // Only use saved cells if grid type matches (otherwise stale data from different grid)
      cells: (!charOverride.gridName || charOverride.gridName === globalLayer.gridName)
        ? (charOverride.cells || null)
        : null,
      // Inherit visibility/opacity from the global layer when the char doesn't
      // override them. Without this fallback, global toggles never reach the
      // render pipeline because every char has an explicit serialized value.
      opacity: charOverride.opacity ?? globalLayer.opacity ?? 1,
      visible: charOverride.visible ?? globalLayer.visible ?? true,
    };
  });
}

/** Serialize runtime layers to per-character overrides (layerOverrides format) */
export function serializeLayerOverrides(layers, global) {
  return layers.map((layer, i) => {
    const globalLayer = global.defaultLayers?.[i];
    if (!globalLayer) return null;
    // Compare against the layer's own gridParams, not the per-type gridDefaults
    const overrides = computeOverrides(layer.gridParams, globalLayer.gridParams || {});
    const out = {
      gridName: globalLayer.gridName,
      gridParamOverrides: overrides,
      cells: layer.cells.map(c => ({
        filled: c.filled,
        manualOverride: c.manualOverride,
        center: c.center,
      })),
    };
    // Only persist opacity/visible when they diverge from the global default,
    // so that future global edits propagate to chars that haven't overridden.
    const gOpacity = globalLayer.opacity ?? 1;
    const gVisible = globalLayer.visible ?? true;
    if (layer.opacity !== gOpacity) out.opacity = layer.opacity;
    if (layer.visible !== gVisible) out.visible = layer.visible;
    return out;
  }).filter(Boolean);
}

// Keep for backward compat during transition (used nowhere after migration)
export function serializeLayerData(layers, global) {
  return serializeLayerOverrides(layers, global);
}

export function exportProject() {
  return JSON.stringify(loadProject(), null, 2);
}

export function importProject(json) {
  let data = JSON.parse(json);
  data = migrateProject(data);
  saveProject(data);
}
