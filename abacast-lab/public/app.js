'use strict';

const state = {
  latestId: null,
  selectedId: null,
  cooldownTimer: null,
  toastTimer: null
};

const els = {
  locationName: document.getElementById('locationName'),
  latestTimestamp: document.getElementById('latestTimestamp'),
  stationLabel: document.getElementById('stationLabel'),
  observationTime: document.getElementById('observationTime'),
  currentObservation: document.getElementById('currentObservation'),
  hourlyBody: document.getElementById('hourlyBody'),
  forecastOffice: document.getElementById('forecastOffice'),
  afdTime: document.getElementById('afdTime'),
  afdPreview: document.getElementById('afdPreview'),
  afdFullText: document.getElementById('afdFullText'),
  systemPrompt: document.getElementById('systemPrompt'),
  exactInput: document.getElementById('exactInput'),
  modelCards: document.getElementById('modelCards'),
  historyStrip: document.getElementById('historyStrip'),
  runButton: document.getElementById('runButton'),
  cooldownText: document.getElementById('cooldownText'),
  latestButton: document.getElementById('latestButton'),
  toast: document.getElementById('toast')
};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  els.runButton.addEventListener('click', runExperiment);
  els.latestButton.addEventListener('click', function() {
    state.selectedId = null;
    loadLatest(true);
  });

  await Promise.all([loadLatest(true), loadHistory()]);

  window.setInterval(function() {
    if (!state.selectedId) loadLatest(false);
    loadHistory();
  }, 60000);
}

async function loadLatest(render) {
  try {
    const payload = await fetchJSON('/api/latest');
    if (!payload.experiment) return;

    state.latestId = payload.experiment.id;
    if (render !== false && !state.selectedId) renderExperiment(payload.experiment);
    markActiveHistory();
  } catch (error) {
    showToast(error.message || 'Unable to load latest experiment');
  }
}

async function loadHistory() {
  try {
    const payload = await fetchJSON('/api/history?limit=20');
    renderHistory(payload.experiments || []);
  } catch (error) {
    console.warn(error);
  }
}

async function loadExperiment(id) {
  state.selectedId = id;
  try {
    const payload = await fetchJSON('/api/experiments/' + encodeURIComponent(id));
    renderExperiment(payload.experiment);
    markActiveHistory();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    showToast(error.message || 'Unable to load experiment');
  }
}

async function runExperiment() {
  els.runButton.disabled = true;
  els.runButton.textContent = 'Running all three models…';
  els.cooldownText.textContent = 'Fetching fresh NWS data and calling each provider in parallel.';

  try {
    const response = await fetch('/api/manual-run', {
      method: 'POST',
      headers: { 'X-AbaCast-Lab': 'dashboard' }
    });
    const payload = await response.json();

    if (response.status === 429) {
      startCooldown(Number(payload.retryAfterSeconds) || 60);
      throw new Error('Easy there, Jim Cantore. The lab is cooling down for a moment.');
    }

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Experiment failed');
    }

    state.selectedId = null;
    state.latestId = payload.experiment.id;
    renderExperiment(payload.experiment);
    await loadHistory();
    startCooldown(Number(payload.manualCooldownSeconds) || 60);
    showToast('Fresh experiment complete.');
  } catch (error) {
    showToast(error.message || 'Experiment failed');
    if (!state.cooldownTimer) {
      els.runButton.disabled = false;
      els.runButton.textContent = '↻ Run New Experiment';
      els.cooldownText.textContent = '';
    }
  }
}

function startCooldown(seconds) {
  if (state.cooldownTimer) window.clearInterval(state.cooldownTimer);

  let remaining = Math.max(1, Math.ceil(seconds));
  els.runButton.disabled = true;

  function tick() {
    els.runButton.textContent = '↻ Run New Experiment';
    els.cooldownText.textContent = 'Next manual run available in ' + remaining + ' second' + (remaining === 1 ? '' : 's') + '.';
    remaining -= 1;

    if (remaining < 0) {
      window.clearInterval(state.cooldownTimer);
      state.cooldownTimer = null;
      els.runButton.disabled = false;
      els.cooldownText.textContent = '';
    }
  }

  tick();
  state.cooldownTimer = window.setInterval(tick, 1000);
}

function renderExperiment(exp) {
  if (!exp) return;

  const timeZone = exp.location && exp.location.timeZone ? exp.location.timeZone : 'America/Chicago';
  els.locationName.textContent = exp.location && exp.location.name ? exp.location.name : 'Plano, TX';
  els.latestTimestamp.textContent =
    (exp.id === state.latestId && !state.selectedId ? 'Latest test: ' : 'Viewing test: ') +
    formatDateTime(exp.createdAt, timeZone) +
    ' · ' + (exp.source === 'manual' ? 'manual run' : 'scheduled run');

  renderCurrent(exp, timeZone);
  renderHourly(exp, timeZone);
  renderAfd(exp, timeZone);

  els.systemPrompt.textContent = exp.systemPrompt || '';
  els.exactInput.textContent = exp.inputText || '';
  renderModels(exp.models || {});
}

function renderCurrent(exp, timeZone) {
  const current = exp.weather && exp.weather.current ? exp.weather.current : null;
  const station = exp.station || {};

  els.stationLabel.textContent = station.id ? '(' + station.id + ')' : '';
  els.observationTime.textContent = current && current.timestamp ? 'Updated ' + formatTime(current.timestamp, timeZone) : '';

  if (!current) {
    els.currentObservation.className = 'metrics-grid empty-state';
    els.currentObservation.textContent = 'Current observation was unavailable for this experiment.';
    return;
  }

  els.currentObservation.className = 'metrics-grid';

  const metrics = [
    ['Conditions', current.description || 'Unavailable'],
    ['Temp', numberWithUnit(current.temperatureF, '°F', 0)],
    ['Feels Like', numberWithUnit(current.apparentTemperatureF, '°F', 0)],
    ['Wind', formatWind(current)],
    ['Humidity', numberWithUnit(current.humidityPercent, '%', 0)],
    ['Gust', Number.isFinite(current.windGustMph) ? Math.round(current.windGustMph) + ' mph' : 'Unavailable']
  ];

  els.currentObservation.innerHTML = metrics.map(function(metric) {
    return '<div class="metric"><span class="metric-label">' + escapeHtml(metric[0]) +
      '</span><span class="metric-value">' + escapeHtml(metric[1]) + '</span></div>';
  }).join('');
}

function renderHourly(exp, timeZone) {
  const hours = exp.weather && Array.isArray(exp.weather.hours) ? exp.weather.hours : [];

  if (!hours.length) {
    els.hourlyBody.innerHTML = '<tr><td colspan="5" class="empty-cell">No hourly forecast available.</td></tr>';
    return;
  }

  els.hourlyBody.innerHTML = hours.map(function(hour) {
    const pop = Number.isFinite(hour.precipitationChancePercent) ? Math.round(hour.precipitationChancePercent) + '%' : '—';
    const temp = Number.isFinite(hour.temperatureF) ? Math.round(hour.temperatureF) + '°' : '—';
    const wind = [hour.windDirection, hour.windSpeed].filter(Boolean).join(' ') || '—';

    return '<tr>' +
      '<td>' + escapeHtml(formatHour(hour.startTime, timeZone)) + '</td>' +
      '<td>' + escapeHtml(hour.shortForecast || 'Unavailable') + '</td>' +
      '<td>' + escapeHtml(temp) + '</td>' +
      '<td>' + escapeHtml(pop) + '</td>' +
      '<td>' + escapeHtml(wind) + '</td>' +
      '</tr>';
  }).join('');
}

function renderAfd(exp, timeZone) {
  const afd = exp.afd;
  els.forecastOffice.textContent = exp.forecastOffice ? '(' + exp.forecastOffice + ')' : '';
  els.afdTime.textContent = afd && afd.issuanceTime ? 'Issued ' + formatDateTime(afd.issuanceTime, timeZone) : '';

  if (!afd || !afd.text) {
    els.afdPreview.className = 'afd-preview empty-state';
    els.afdPreview.textContent = 'No AFD was available for this run.';
    els.afdFullText.textContent = '';
    return;
  }

  els.afdPreview.className = 'afd-preview';
  els.afdPreview.textContent = (afd.section ? afd.section + '\n\n' : '') + afd.text;
  els.afdFullText.textContent = afd.text;
}

function renderModels(models) {
  const ordered = [
    ['openai', models.openai],
    ['anthropic', models.anthropic],
    ['gemini', models.gemini]
  ];

  els.modelCards.innerHTML = ordered.map(function(item) {
    return providerCard(item[0], item[1]);
  }).join('');
}

function providerCard(key, model) {
  const config = {
    openai: { mark: 'O', provider: 'OpenAI' },
    anthropic: { mark: 'A', provider: 'Anthropic' },
    gemini: { mark: 'G', provider: 'Google' }
  }[key];

  if (!model) {
    return '<section class="model-card" data-provider="' + key + '">' +
      '<div class="model-head"><div class="model-identity"><div class="provider-mark">' + config.mark + '</div>' +
      '<div><div class="model-name">Waiting…</div><span class="provider-name">' + config.provider + '</span></div></div></div>' +
      '<div class="model-copy model-error">No result was stored for this provider.</div></section>';
  }

  const compliant = Boolean(model.ok && model.withinCharacterLimit && model.endsWithEmoji);
  const charLabel = Number.isFinite(model.charCount) ? model.charCount + ' characters' : 'No character count';
  const responseClass = model.ok ? 'model-copy' : 'model-copy model-error';
  const responseText = model.ok ? model.text : (model.error || 'Provider request failed');
  const tokenText = formatTokens(model);
  const costText = Number.isFinite(model.estimatedCostUsd) ? formatCost(model.estimatedCostUsd) : '—';
  const latencyText = Number.isFinite(model.latencyMs) ? (model.latencyMs / 1000).toFixed(2) + ' s' : '—';

  return '<section class="model-card" data-provider="' + key + '">' +
    '<div class="model-head">' +
      '<div class="model-identity">' +
        '<div class="provider-mark">' + config.mark + '</div>' +
        '<div><div class="model-name">' + escapeHtml(model.model || config.provider) + '</div>' +
        '<span class="provider-name">' + escapeHtml(config.provider) + '</span></div>' +
      '</div>' +
      '<div class="compliance">' + escapeHtml(charLabel) +
        '<span class="compliance-dot' + (compliant ? '' : ' warn') + '">' + (compliant ? '✓' : '!') + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="' + responseClass + '">' + escapeHtml(responseText) + '</div>' +
    '<div class="model-stats">' +
      stat('Latency', latencyText) +
      stat('Tokens', tokenText) +
      stat('Est. cost', costText) +
    '</div>' +
  '</section>';
}

function stat(label, value) {
  return '<div class="model-stat"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
}

function renderHistory(items) {
  if (!items.length) {
    els.historyStrip.innerHTML = '<span class="muted">No history yet.</span>';
    return;
  }

  els.historyStrip.innerHTML = items.map(function(item) {
    const active = state.selectedId ? item.id === state.selectedId : item.id === state.latestId;
    return '<button type="button" class="history-button' + (active ? ' active' : '') + '" data-id="' + escapeHtml(item.id) + '">' +
      '<strong>' + escapeHtml(formatTime(item.createdAt, 'America/Chicago')) + '</strong>' +
      '<span>' + escapeHtml(formatShortDate(item.createdAt, 'America/Chicago')) + (item.source === 'manual' ? ' · manual' : '') + '</span>' +
      '</button>';
  }).join('');

  Array.from(els.historyStrip.querySelectorAll('.history-button')).forEach(function(button) {
    button.addEventListener('click', function() {
      loadExperiment(button.getAttribute('data-id'));
    });
  });
}

function markActiveHistory() {
  Array.from(els.historyStrip.querySelectorAll('.history-button')).forEach(function(button) {
    const id = button.getAttribute('data-id');
    const active = state.selectedId ? id === state.selectedId : id === state.latestId;
    button.classList.toggle('active', active);
  });
}

async function fetchJSON(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(function() { return {}; });
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || 'Request failed');
  }
  return payload;
}

function formatTokens(model) {
  const input = Number.isFinite(model.inputTokens) ? model.inputTokens : null;
  const output = Number.isFinite(model.outputTokens) ? model.outputTokens : null;
  const reasoning = Number.isFinite(model.reasoningTokens) && model.reasoningTokens > 0 ? model.reasoningTokens : null;

  if (input == null && output == null) return '—';

  let text = (input == null ? '—' : input.toLocaleString()) + ' in / ' +
    (output == null ? '—' : output.toLocaleString()) + ' out';

  if (reasoning != null) text += ' + ' + reasoning.toLocaleString() + ' think';
  return text;
}

function formatCost(value) {
  if (value < 0.0001) return '$' + value.toFixed(6);
  if (value < 0.01) return '$' + value.toFixed(5);
  return '$' + value.toFixed(4);
}

function formatDateTime(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value || 'Unknown time';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(date);
}

function formatTime(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value || '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone,
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function formatHour(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value || '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone,
    hour: 'numeric'
  }).format(date);
}

function formatShortDate(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone,
    month: 'short',
    day: 'numeric'
  }).format(date);
}

function formatWind(current) {
  if (!Number.isFinite(current.windSpeedMph)) return 'Unavailable';
  const direction = current.windDirection || '';
  return (direction ? direction + ' ' : '') + Math.round(current.windSpeedMph) + ' mph';
}

function numberWithUnit(value, unit, digits) {
  if (!Number.isFinite(value)) return 'Unavailable';
  return value.toFixed(digits) + unit;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  if (state.toastTimer) window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(function() {
    els.toast.classList.remove('show');
  }, 4200);
}
