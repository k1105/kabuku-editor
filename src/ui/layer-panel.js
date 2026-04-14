import { getAllGrids } from '../grids/grid-plugin.js';
import { createLayer } from '../core/layer.js';

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

      const vis = document.createElement('span');
      vis.className = 'visibility';
      vis.textContent = layer.visible ? '👁' : '—';
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
        const del = document.createElement('span');
        del.className = 'visibility';
        del.textContent = 'x';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          callbacks.onDelete(i);
        });
        li.appendChild(del);
      }

      list.appendChild(li);
    });

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
    update(newLayers, newActiveIdx) {
      layers = newLayers;
      activeLayerIdx = newActiveIdx;
      render();
    },
  };
}
