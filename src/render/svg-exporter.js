/**
 * Export layer cells to SVG string.
 */
export function exportLayerToSVG(layer, width, height) {
  const paths = [];
  for (const cell of layer.cells) {
    if (!cell.filled) continue;
    // Convert Path2D to SVG path data by re-drawing
    // Since Path2D doesn't expose path data, we reconstruct from cell info
    paths.push(cellToSVGPath(cell, layer.gridPlugin.name));
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <g fill="#000">
    ${paths.join('\n    ')}
  </g>
</svg>`;
}

export function exportAllLayersToSVG(layers, width, height) {
  const groups = [];
  for (const layer of layers) {
    if (!layer.visible) continue;
    const paths = [];
    for (const cell of layer.cells) {
      if (!cell.filled) continue;
      paths.push(cellToSVGPath(cell, layer.gridPlugin.name));
    }
    if (paths.length > 0) {
      groups.push(`  <g fill="#000" opacity="${layer.opacity}" id="${layer.id}">
    ${paths.join('\n    ')}
  </g>`);
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${groups.join('\n')}
</svg>`;
}

function cellToSVGPath(cell, gridName) {
  const { x, y } = cell.center;
  if (gridName === 'PixelGrid') {
    // Reconstruct rect from center — need size info, approximate from path
    // We'll store extra info on cells in the future; for now use a marker
    return `<rect x="${x - 8}" y="${y - 8}" width="16" height="16"/>`;
  }
  // For circle-based grids, use circle element
  return `<circle cx="${x}" cy="${y}" r="6"/>`;
}

export function downloadSVG(svgString, filename) {
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
