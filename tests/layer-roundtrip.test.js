import { describe, it, expect } from 'vitest';
import { buildRuntimeLayers } from '../src/core/layer-builder.js';
import { serializeLayerOverrides } from '../src/core/project.js';
import { GRID_SPACE } from '../src/core/cell-codec.js';

/**
 * Save → load round-trip through the real serialization pipeline
 * (serializeLayerOverrides → cellsV2 → buildRuntimeLayers) with the real
 * FibonacciGrid, covering both the fast index path (params unchanged) and the
 * nearest-center fallback (global params drifted after save).
 */

const PARAMS = { count: 120, scale: 16, dotRadius: 10, rotation: 0 };

function makeGlobal(gridParams = PARAMS) {
  return {
    defaultLayers: [{ gridName: 'FibonacciGrid', gridParams: { ...gridParams }, name: 'FibonacciGrid' }],
  };
}

function paint(layers) {
  const cells = layers[0].cells;
  const filledIdx = [3, 17, 42, 99];
  for (const i of filledIdx) cells[i].filled = true;
  cells[17].orientation = 123.4;
  cells[17].coherence = 0.66;
  cells[17].orientationSource = 'manual';
  cells[50].manualOverride = true; // manually erased
  return filledIdx;
}

describe('cellsV2 round-trip through buildRuntimeLayers', () => {
  it('restores fills and orientation via the fast index path', () => {
    const global = makeGlobal();
    const layers = buildRuntimeLayers(global, {}, GRID_SPACE);
    const filledIdx = paint(layers);
    const charData = { layerOverrides: serializeLayerOverrides(layers, global) };

    const rebuilt = buildRuntimeLayers(global, charData, GRID_SPACE);
    const cells = rebuilt[0].cells;
    expect(cells.map((c, i) => (c.filled ? i : -1)).filter((i) => i >= 0)).toEqual(filledIdx);
    expect(cells[17].orientation).toBeCloseTo(123.4);
    expect(cells[17].coherence).toBeCloseTo(0.66);
    expect(cells[17].orientationSource).toBe('manual');
    expect(cells[50].manualOverride).toBe(true);
    expect(cells[50].filled).toBeFalsy();
  });

  it('survives a global grid-param tweak via nearest-center fallback', () => {
    const globalAtSave = makeGlobal();
    const layers = buildRuntimeLayers(globalAtSave, {}, GRID_SPACE);
    const filledIdx = paint(layers);
    const charData = { layerOverrides: serializeLayerOverrides(layers, globalAtSave) };

    // The user then rotates the global grid by 1° — cells shift slightly but
    // stay within the nearest-center match tolerance.
    const globalNow = makeGlobal({ ...PARAMS, rotation: 1 });
    const rebuilt = buildRuntimeLayers(globalNow, charData, GRID_SPACE);
    const filledNow = rebuilt[0].cells.filter((c) => c.filled).length;
    expect(filledNow).toBe(filledIdx.length);
    const oriented = rebuilt[0].cells.find((c) => c.orientation != null);
    expect(oriented?.orientation).toBeCloseTo(123.4);
  });

  it('still reads the legacy cells format (pre-cellsV2 documents)', () => {
    const global = makeGlobal();
    const reference = buildRuntimeLayers(global, {}, GRID_SPACE)[0].cells;
    const legacy = {
      layerOverrides: [{
        gridName: 'FibonacciGrid',
        gridParamOverrides: {},
        cells: [
          { center: reference[5].center, filled: true },
          { center: reference[9].center, filled: true, orientation: 90, coherence: 0.5, orientationSource: 'image' },
        ],
      }],
    };
    const rebuilt = buildRuntimeLayers(global, legacy, GRID_SPACE);
    const cells = rebuilt[0].cells;
    expect(cells[5].filled).toBe(true);
    expect(cells[9].filled).toBe(true);
    expect(cells[9].orientation).toBe(90);
  });
});
