/* 临时施工区域冲突分析台 - 前端逻辑 */
'use strict';

// ---------- 状态 ----------
const state = {
  zones: [],
  layers: [],
  selectedLayers: new Set(),
  lastResult: null,
  typeFilter: 'all',
};

// 冲突类型展示配置
const CONFLICT_TYPES = {
  spatial: { label: '空间冲突', color: '#d0000b' },
  resource: { label: '资源冲突', color: '#e8590c' },
  both: { label: '空间+资源冲突', color: '#9c36b5' },
};
function typeLabel(t) {
  return (CONFLICT_TYPES[t] || {}).label || t || '空间冲突';
}

// ---------- 地图 ----------
const map = L.map('map').setView([31.23, 121.47], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const zonesLayer = L.layerGroup().addTo(map);
const conflictsLayer = L.layerGroup().addTo(map);

const LAYER_COLORS = ['#2b8a3e', '#1971c2', '#e8590c', '#9c36b5', '#c2255c', '#0b7285', '#5f3dc4', '#a61e4d'];
function layerColor(layer) {
  const idx = Math.max(0, state.layers.indexOf(layer));
  return LAYER_COLORS[idx % LAYER_COLORS.length];
}

// ---------- 工具 ----------
const $ = (id) => document.getElementById(id);

function fmtArea(m2) {
  return m2 >= 10000 ? `${(m2 / 10000).toFixed(2)} 公顷` : `${m2.toLocaleString('zh-CN')} m²`;
}
function fmtDate(iso) {
  return iso ? iso.slice(0, 10) : '-';
}
function showMsg(el, text, ok) {
  el.textContent = text;
  el.className = `msg ${ok ? 'ok' : 'err'}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

// ---------- 区域渲染 ----------
function renderZones() {
  $('zoneCount').textContent = state.zones.length;
  const list = $('zoneList');
  list.innerHTML = '';

  zonesLayer.clearLayers();
  const bounds = [];

  for (const z of state.zones) {
    const li = document.createElement('li');
    const resTags = (z.resources || []).length
      ? `<div class="meta">资源：${z.resources.map(escapeHtml).join('、')}</div>`
      : '';
    li.innerHTML = `
      <span>
        <span class="badge" style="background:${layerColor(z.layer)};color:#fff">${escapeHtml(z.layer)}</span>
        <strong>${escapeHtml(z.name)}</strong>
        <div class="meta">${fmtDate(z.start)} ~ ${fmtDate(z.end)}</div>
        ${resTags}
      </span>`;
    const del = document.createElement('button');
    del.className = 'danger small';
    del.textContent = '删除';
    del.onclick = () => deleteZone(z.id);
    li.appendChild(del);
    list.appendChild(li);

    const geo = L.geoJSON(
      { type: 'Feature', geometry: z.geometry, properties: z },
      {
        style: { color: layerColor(z.layer), weight: 2, fillOpacity: 0.15 },
        onEachFeature: (f, l) => l.bindPopup(
          `<b>${escapeHtml(z.name)}</b><br>图层：${escapeHtml(z.layer)}<br>${fmtDate(z.start)} ~ ${fmtDate(z.end)}` +
          ((z.resources || []).length ? `<br>资源：${z.resources.map(escapeHtml).join('、')}` : '')
        ),
      }
    );
    geo.addTo(zonesLayer);
    try { bounds.push(geo.getBounds()); } catch { /* ignore */ }
  }

  if (bounds.length) {
    const b = bounds.reduce((acc, cur) => acc.extend(cur));
    map.fitBounds(b.pad(0.1));
  }
}

function renderLayerFilters() {
  const box = $('layerFilters');
  box.innerHTML = '';
  if (!state.layers.length) {
    box.innerHTML = '<em>暂无图层</em>';
    return;
  }
  for (const layer of state.layers) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selectedLayers.has(layer);
    cb.onchange = () => {
      cb.checked ? state.selectedLayers.add(layer) : state.selectedLayers.delete(layer);
    };
    const swatch = document.createElement('span');
    swatch.style.cssText = `display:inline-block;width:12px;height:12px;border-radius:2px;background:${layerColor(layer)}`;
    label.append(cb, swatch, document.createTextNode(` ${layer}`));
    box.appendChild(label);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 数据加载 ----------
async function refreshZones() {
  const [{ zones }, { layers }] = await Promise.all([api('/api/zones'), api('/api/layers')]);
  state.zones = zones;
  state.layers = layers;
  layers.forEach((l) => state.selectedLayers.add(l)); // 新图层默认勾选
  renderZones();
  renderLayerFilters();
}

async function importGeoJSON(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    showMsg($('importMsg'), 'JSON 解析失败，请检查格式', false);
    return;
  }
  try {
    const res = await api('/api/zones/import', { method: 'POST', body: JSON.stringify(data) });
    showMsg($('importMsg'), `成功导入 ${res.imported} 个区域`, true);
    $('geojsonInput').value = '';
    await refreshZones();
  } catch (err) {
    showMsg($('importMsg'), err.message, false);
  }
}

async function deleteZone(id) {
  await api(`/api/zones/${id}`, { method: 'DELETE' });
  await refreshZones();
}

// ---------- 分析 ----------
async function runAnalysis() {
  const layers = state.layers.filter((l) => state.selectedLayers.has(l));
  const body = {
    layers,
    start: $('rangeStart').value || undefined,
    end: $('rangeEnd').value || undefined,
  };
  try {
    const result = await api('/api/analyze', { method: 'POST', body: JSON.stringify(body) });
    state.lastResult = result;
    renderConflicts(result);
  } catch (err) {
    alert(`分析失败：${err.message}`);
  }
}

function renderConflicts(result) {
  const counts = result.conflictCountByType || {
    spatial: result.conflicts.filter((c) => c.conflictType === 'spatial').length,
    resource: result.conflicts.filter((c) => c.conflictType === 'resource').length,
    both: result.conflicts.filter((c) => c.conflictType === 'both').length,
  };
  $('conflictSummary').textContent =
    `${result.conflictCount} 处冲突（空间 ${counts.spatial} / 资源 ${counts.resource} / 空间+资源 ${counts.both}）` +
    ` · 重叠面积共 ${fmtArea(result.totalConflictAreaM2)}`;

  conflictsLayer.clearLayers();
  const list = $('conflictList');
  list.innerHTML = '';

  // 按冲突类型筛选
  const filtered = state.typeFilter === 'all'
    ? result.conflicts
    : result.conflicts.filter((c) => c.conflictType === state.typeFilter);

  if (!result.conflicts.length) {
    list.innerHTML = '<em>未发现时空重叠或共享资源冲突。</em>';
    return;
  }
  if (!filtered.length) {
    list.innerHTML = '<em>当前类型筛选下没有冲突，请切换筛选条件。</em>';
    return;
  }

  filtered.forEach((c) => {
    const idx = result.conflicts.indexOf(c); // 保持完整结果中的编号稳定
    const typeInfo = CONFLICT_TYPES[c.conflictType] || CONFLICT_TYPES.spatial;

    // 地图高亮相交区域（纯资源冲突无空间相交，不上图）
    let geo = null;
    if (c.geometry) {
      geo = L.geoJSON(
        { type: 'Feature', geometry: c.geometry, properties: c },
        { style: { color: typeInfo.color, weight: 2, fillColor: typeInfo.color, fillOpacity: 0.45 } }
      );
      geo.bindPopup(
        `<b>冲突 ${idx + 1}（${typeLabel(c.conflictType)}）</b><br>` +
        `${escapeHtml(c.zones.map((z) => z.name).join(' ∩ '))}<br>` +
        `重叠面积：${fmtArea(c.areaM2)}<br>重叠期：${fmtDate(c.overlapStart)} ~ ${fmtDate(c.overlapEnd)}（${c.overlapDays} 天）` +
        ((c.sharedResources || []).length ? `<br>共享资源：${c.sharedResources.map(escapeHtml).join('、')}` : '')
      );
      geo.addTo(conflictsLayer);
    }

    // 列表项
    const item = document.createElement('div');
    item.className = 'conflict-item';
    item.style.borderLeftColor = typeInfo.color;
    const zoneTags = c.zones
      .map((z) => `<span class="tag">${escapeHtml(z.name)}（${escapeHtml(z.layer)}）</span>`)
      .join(' ');
    const resTags = (c.sharedResources || []).length
      ? `<br>共享资源：${c.sharedResources.map((r) => `<span class="tag resource">${escapeHtml(r)}</span>`).join(' ')}`
      : '';
    const areaLine = c.geometry ? `重叠面积 ${fmtArea(c.areaM2)}` : '无空间相交（仅资源冲突）';
    const suggestions = c.suggestions.map((s) => `<li>${escapeHtml(s.text)}</li>`).join('');
    item.innerHTML = `
      <h3>
        <span class="type-badge" style="background:${typeInfo.color}">${typeLabel(c.conflictType)}</span>
        #${idx + 1} ${areaLine}
      </h3>
      <div class="stats">
        ${zoneTags}${resTags}<br>
        重叠时段：${fmtDate(c.overlapStart)} ~ ${fmtDate(c.overlapEnd)}（${c.overlapDays} 天）
      </div>
      <details>
        <summary>错峰建议（${c.suggestions.length} 条）</summary>
        <ul class="suggestions">${suggestions}</ul>
      </details>`;
    if (geo) {
      item.onclick = () => {
        map.fitBounds(geo.getBounds().pad(0.3));
        geo.openPopup();
      };
    } else {
      item.classList.add('no-geometry');
    }
    list.appendChild(item);
  });
}

// ---------- 已保存分析 ----------
async function refreshAnalyses() {
  const { analyses } = await api('/api/analyses');
  const list = $('analysisList');
  list.innerHTML = '';
  if (!analyses.length) {
    list.innerHTML = '<li><em>暂无已保存分析</em></li>';
    return;
  }
  for (const a of analyses) {
    const li = document.createElement('li');
    const typeInfo = a.conflictCountByType
      ? `（空间 ${a.conflictCountByType.spatial} / 资源 ${a.conflictCountByType.resource} / 空间+资源 ${a.conflictCountByType.both}）`
      : '';
    li.innerHTML = `
      <span>
        <strong>${escapeHtml(a.name)}</strong>
        <div class="meta">${new Date(a.savedAt).toLocaleString('zh-CN')} · ${a.conflictCount} 处冲突${typeInfo} · ${fmtArea(a.totalConflictAreaM2)}</div>
      </span>`;
    const btns = document.createElement('span');
    btns.className = 'row';
    btns.style.marginBottom = '0';

    const view = document.createElement('button');
    view.className = 'small';
    view.textContent = '查看';
    view.onclick = async () => {
      const record = await api(`/api/analyses/${a.id}`);
      state.lastResult = record.result;
      renderConflicts(record.result);
    };

    const exp = document.createElement('button');
    exp.className = 'small';
    exp.textContent = '导出';
    exp.onclick = () => { window.location.href = `/api/analyses/${a.id}/export`; };

    const del = document.createElement('button');
    del.className = 'danger small';
    del.textContent = '删除';
    del.onclick = async () => {
      await api(`/api/analyses/${a.id}`, { method: 'DELETE' });
      await refreshAnalyses();
    };

    btns.append(view, exp, del);
    li.appendChild(btns);
    list.appendChild(li);
  }
}

// ---------- 事件绑定 ----------
$('importBtn').onclick = () => importGeoJSON($('geojsonInput').value.trim());

$('fileInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { $('geojsonInput').value = reader.result; };
  reader.readAsText(file);
};

$('loadSampleBtn').onclick = async () => {
  const res = await fetch('/sample.geojson');
  $('geojsonInput').value = JSON.stringify(await res.json(), null, 2);
};

$('clearBtn').onclick = async () => {
  if (!confirm('确定清空全部已导入区域？')) return;
  await api('/api/zones', { method: 'DELETE' });
  state.selectedLayers.clear();
  conflictsLayer.clearLayers();
  state.lastResult = null;
  $('conflictList').innerHTML = '<em>运行分析后在此展示，按重叠面积降序排列。</em>';
  $('conflictSummary').textContent = '未运行';
  $('typeFilter').value = 'all';
  state.typeFilter = 'all';
  await refreshZones();
};

$('analyzeBtn').onclick = runAnalysis;

$('typeFilter').onchange = (e) => {
  state.typeFilter = e.target.value;
  if (state.lastResult) renderConflicts(state.lastResult);
};

$('saveAnalysisBtn').onclick = async () => {
  if (!state.lastResult) {
    alert('请先运行一次分析');
    return;
  }
  try {
    await api('/api/analyses', {
      method: 'POST',
      body: JSON.stringify({
        name: $('analysisName').value || undefined,
        params: state.lastResult.params,
        result: state.lastResult,
      }),
    });
    $('analysisName').value = '';
    await refreshAnalyses();
  } catch (err) {
    alert(`保存失败：${err.message}`);
  }
};

// ---------- 启动 ----------
(async function init() {
  try {
    await Promise.all([refreshZones(), refreshAnalyses()]);
  } catch (err) {
    console.error('初始化失败', err);
  }
})();
