/**
 * Toolbar: paint/erase tool switching + preview toggle
 */
export function createToolbar(onToolChange, onPreviewChange) {
  let currentTool = 'paint';
  let preview = false;

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
      btn.className = `tool-btn${currentTool === tool.id && !preview ? ' active' : ''}`;
      btn.textContent = tool.label;
      btn.addEventListener('click', () => {
        currentTool = tool.id;
        preview = false;
        onToolChange(currentTool);
        onPreviewChange(false);
        render();
      });
      btns.appendChild(btn);
    }

    // Preview toggle
    const previewBtn = document.createElement('button');
    previewBtn.className = `tool-btn${preview ? ' active' : ''}`;
    previewBtn.textContent = 'Preview';
    previewBtn.addEventListener('click', () => {
      preview = !preview;
      onPreviewChange(preview);
      render();
    });
    btns.appendChild(previewBtn);

    el.appendChild(btns);
  }

  render();

  return {
    el,
    getTool() { return currentTool; },
    isPreview() { return preview; },
  };
}
