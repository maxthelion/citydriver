/**
 * Score panel UI: displays validator results in an overlay table.
 */

/**
 * Create the score panel DOM element.
 * @returns {HTMLElement}
 */
export function createScorePanel() {
  const panel = document.createElement('div');
  panel.id = 'score-panel';
  panel.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    background: rgba(0,0,0,0.85);
    color: #eee;
    font-family: monospace;
    font-size: 12px;
    padding: 12px;
    border-radius: 6px;
    max-width: 320px;
    max-height: 80vh;
    overflow-y: auto;
    z-index: 100;
    pointer-events: auto;
  `;
  return panel;
}

/**
 * Update the score panel with validator results.
 * @param {HTMLElement} panel
 * @param {{ results, valid, structural, quality, overall }} scores
 */
export function updateScorePanel(panel, scores) {
  let html = '<div style="margin-bottom:8px;font-size:14px;font-weight:bold">Validators</div>';

  const validColor = scores.valid ? '#4f4' : '#f44';
  html += `<div style="color:${validColor}">Valid: ${scores.valid ? 'PASS' : 'FAIL'}</div>`;
  html += `<div>Structural: ${(scores.structural * 100).toFixed(1)}%</div>`;
  html += `<div>Quality: ${(scores.quality * 100).toFixed(1)}%</div>`;
  html += `<div style="margin-bottom:8px">Overall: ${(scores.overall * 100).toFixed(1)}%</div>`;
  html += '<hr style="border-color:#444;margin:4px 0">';

  for (const r of scores.results) {
    const tierLabel = `T${r.tier}`;
    let valStr, color;

    if (r.tier === 1) {
      valStr = r.value ? 'PASS' : 'FAIL';
      color = r.value ? '#4f4' : '#f44';
    } else {
      const pct = (r.value * 100).toFixed(0);
      valStr = `${pct}%`;
      color = r.value > 0.7 ? '#4f4' : r.value > 0.4 ? '#ff4' : '#f44';
    }

    html += `<div style="color:${color}">[${tierLabel}] ${r.name}: ${valStr}</div>`;
  }

  panel.innerHTML = html;
}
