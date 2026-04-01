const STORAGE_KEY = 'kabuku_project';

const DEFAULT_GLOBAL = {
  stretchAngle: 0,
  stretchAmount: 0,
};

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

export function loadProject() {
  try {
    const json = localStorage.getItem(STORAGE_KEY);
    if (json) {
      const data = JSON.parse(json);
      if (!data.global) data.global = { ...DEFAULT_GLOBAL };
      return data;
    }
  } catch (e) {
    console.warn('Failed to load project:', e);
  }
  return { characters: {}, global: { ...DEFAULT_GLOBAL } };
}

export function saveProject(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('Failed to save project:', e);
  }
}

export function getGlobal() {
  return loadProject().global || { ...DEFAULT_GLOBAL };
}

export function saveGlobal(global) {
  const project = loadProject();
  project.global = global;
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

export function serializeLayerData(layers) {
  return layers.map(layer => ({
    id: layer.id,
    name: layer.name,
    gridName: layer.gridPlugin.name,
    gridParams: layer.gridParams,
    cells: layer.cells.map(c => ({
      filled: c.filled,
      manualOverride: c.manualOverride,
      center: c.center,
    })),
    opacity: layer.opacity,
    visible: layer.visible,
  }));
}

export function exportProject() {
  return JSON.stringify(loadProject(), null, 2);
}

export function importProject(json) {
  const data = JSON.parse(json);
  saveProject(data);
}
