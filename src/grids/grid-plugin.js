/**
 * GridPlugin interface (documented, not enforced at runtime):
 *
 * {
 *   name: string,
 *   generateCells(width, height, params): Cell[],
 *   getParamDefs(): ParamDef[],
 * }
 *
 * ParamDef: { key, label, min, max, default, step }
 */

import { PixelGrid } from './pixel-grid.js';
import { CircleGrid } from './circle-grid.js';
import { FibonacciGrid } from './fibonacci-grid.js';
import { EllipseGrid } from './ellipse-grid.js';
import { VoronoiGrid } from './voronoi-grid.js';

/** @type {Object.<string, GridPlugin>} */
const registry = {};

export function registerGrid(plugin) {
  registry[plugin.name] = plugin;
}

export function getGrid(name) {
  return registry[name];
}

export function getAllGrids() {
  return Object.values(registry);
}

// Register built-in grids
registerGrid(PixelGrid);
registerGrid(CircleGrid);
registerGrid(FibonacciGrid);
registerGrid(EllipseGrid);
registerGrid(VoronoiGrid);
