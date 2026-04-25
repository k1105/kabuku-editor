/**
 * Toolbar: paint/erase tool switching
 */
export function createToolbar(onToolChange) {
  let currentTool = 'paint';

  const el = document.createElement('div');
  el.className = 'param-group';

  function render() {
    el.innerHTML = '';
    const title = document.createElement('h3');
    title.textContent = 'Tools';
    el.appendChild(title);

    const btns = document.createElement('div');
    btns.className = 'tool-buttons';

    const tools = [
      { id: 'paint', label: 'Paint' },
      { id: 'erase', label: 'Erase' },
    ];

    for (const tool of tools) {
      const btn = document.createElement('button');
      btn.className = `tool-btn${currentTool === tool.id ? ' active' : ''}`;
      btn.textContent = tool.label;
      btn.addEventListener('click', () => {
        currentTool = tool.id;
        onToolChange(currentTool);
        render();
      });
      btns.appendChild(btn);
    }

    el.appendChild(btns);
  }

  render();

  return {
    el,
    getTool() { return currentTool; },
  };
}
