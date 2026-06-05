import { getAllGrids } from '../grids/grid-plugin.js';
import { createLayer } from '../core/layer.js';
import { iconEl } from './icons.js';

export function createLayerPanel(layers, activeLayerIdx, callbacks) {
  const el = document.createElement('div');
  el.className = 'param-group';
  const readOnly = !!callbacks.readOnly;

  function render() {
    el.innerHTML = '';
    const title = document.createElement('h3');
    title.textContent = 'Layers';
    el.appendChild(title);

    const list = document.createElement('ul');
    list.className = 'layer-list';

    layers.forEach((layer, i) => {
      const li = document.createElement('li');
      li.className = `layer-item${i === activeLayerIdx ? ' active' : ''}`;

      const vis = document.createElement('button');
      vis.type = 'button';
      vis.className = 'visibility';
      vis.title = layer.visible ? 'Hide layer' : 'Show layer';
      vis.appendChild(iconEl(layer.visible ? 'eye' : 'eyeOff'));
      vis.addEventListener('click', (e) => {
        e.stopPropagation();
        layer.visible = !layer.visible;
        callbacks.onVisibilityChange(i);
        render();
      });

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = layer.name;

      const opSlider = document.createElement('input');
      opSlider.type = 'range';
      opSlider.className = 'opacity-slider';
      opSlider.min = 0;
      opSlider.max = 1;
      opSlider.step = 0.05;
      opSlider.value = layer.opacity;
      opSlider.addEventListener('input', (e) => {
        e.stopPropagation();
        layer.opacity = parseFloat(opSlider.value);
        callbacks.onOpacityChange(i);
      });

      li.addEventListener('click', () => callbacks.onSelect(i));
      li.appendChild(vis);
      li.appendChild(name);
      li.appendChild(opSlider);

      if (!readOnly && layers.length > 1) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'visibility';
        del.title = 'Delete layer';
        del.appendChild(iconEl('trash'));
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          callbacks.onDelete(i);
        });
        li.appendChild(del);
      }

      list.appendChild(li);
    });

    // Base layer (下地) — a special item pinned to the end of the list that
    // represents the source image / kanjivg backdrop rather than a grid layer.
    // It has no visibility/opacity/delete controls; clicking it surfaces the
    // image placement params instead of grid params.
    if (callbacks.baseLayer) {
      const li = document.createElement('li');
      li.className = `layer-item base-layer-item${callbacks.baseLayer.active ? ' active' : ''}`;

      const icon = iconEl('imagePlus');
      icon.classList.add('base-layer-icon');

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = callbacks.baseLayer.name;

      li.addEventListener('click', () => callbacks.onSelectBase && callbacks.onSelectBase());
      li.appendChild(icon);
      li.appendChild(name);
      list.appendChild(li);
    }

    el.appendChild(list);

    if (!readOnly) {
      const actions = document.createElement('div');
      actions.className = 'layer-actions';

      const addBtn = document.createElement('button');
      addBtn.textContent = '+ Add Layer';
      addBtn.addEventListener('click', () => callbacks.onAdd());
      actions.appendChild(addBtn);

      el.appendChild(actions);
    }
  }

  render();

  return {
    el,
    update(newLayers, newActiveIdx, baseActive) {
      layers = newLayers;
      activeLayerIdx = newActiveIdx;
      if (callbacks.baseLayer && baseActive !== undefined) {
        callbacks.baseLayer.active = baseActive;
      }
      render();
    },
  };
}
