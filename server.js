'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { analyze, normalizeZone } = require('./src/analysis');
const { precheckGeoJSON, extractFeatures } = require('./src/precheck');
const store = require('./src/store');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- 健康检查 ----
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ---- 区域管理 ----

// 列出全部区域
app.get('/api/zones', (req, res) => {
  res.json({ zones: store.listZones() });
});

// 质量预检：不写入任何数据，逐要素返回错误/警告（含 JSONPath）与规范化预览
app.post('/api/zones/precheck', (req, res) => {
  try {
    res.json(precheckGeoJSON(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 确认导入：写入预检生成的规范化要素（body 由预检结果页回传）
// { normalized: FeatureCollection, indexes?: number[] }
// 仅导入预检通过（无阻断性错误）的要素；用户确认是写入区域库的前置条件
app.post('/api/zones/import-confirmed', (req, res) => {
  try {
    const body = req.body || {};
    if (!body.confirmed) {
      return res.status(400).json({ error: '需要用户确认后才能导入（confirmed: true）' });
    }
    const { features } = extractFeatures(body.normalized);
    if (!features.length) {
      return res.status(400).json({ error: '没有可导入的规范化要素（预检通过项为空）' });
    }

    // 可选：仅导入勾选的要素（按原 GeoJSON 中的要素索引过滤）
    let selected = features;
    if (Array.isArray(body.indexes)) {
      const wanted = new Set(body.indexes.map(Number));
      // normalized.features 按可导入要素顺序排列，用 importableIndexes 对齐原始索引
      const mapping = Array.isArray(body.importableIndexes) ? body.importableIndexes : null;
      selected = features.filter((_, i) => wanted.has(mapping ? mapping[i] : i));
    }
    if (!selected.length) {
      return res.status(400).json({ error: '所选要素索引均不可导入' });
    }

    const zones = selected.map((f, i) => {
      const z = normalizeZone(f, i); // 规范化要素仍做一次最终校验
      z.id = crypto.randomUUID();
      z.importedAt = new Date().toISOString();
      return z;
    });
    store.addZones(zones);
    res.status(201).json({ imported: zones.length, zones });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 导入 GeoJSON（FeatureCollection / 单个 Feature / 几何数组均可）
app.post('/api/zones/import', (req, res) => {
  try {
    const body = req.body;
    let features = [];
    if (body && body.type === 'FeatureCollection' && Array.isArray(body.features)) {
      features = body.features;
    } else if (body && body.type === 'Feature') {
      features = [body];
    } else if (Array.isArray(body)) {
      features = body;
    } else {
      return res.status(400).json({ error: '请求体必须是 GeoJSON FeatureCollection 或 Feature' });
    }
    if (features.length === 0) {
      return res.status(400).json({ error: 'GeoJSON 中没有任何要素' });
    }

    const zones = features.map((f, i) => {
      const z = normalizeZone(f, i);
      z.id = crypto.randomUUID();
      z.importedAt = new Date().toISOString();
      return z;
    });
    store.addZones(zones);
    res.status(201).json({ imported: zones.length, zones });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 删除单个区域
app.delete('/api/zones/:id', (req, res) => {
  const removed = store.deleteZone(req.params.id);
  res.status(removed ? 204 : 404).end();
});

// 清空全部区域
app.delete('/api/zones', (req, res) => {
  store.clearZones();
  res.status(204).end();
});

// 图层列表
app.get('/api/layers', (req, res) => {
  const layers = [...new Set(store.listZones().map((z) => z.layer))].sort();
  res.json({ layers });
});

// ---- 冲突分析 ----

// 运行分析：body { layers?: string[], start?: string, end?: string }
app.post('/api/analyze', (req, res) => {
  const result = analyze(store.listZones(), req.body || {});
  res.json(result);
});

// ---- 已保存的分析 ----

// 保存一次分析结果
app.post('/api/analyses', (req, res) => {
  const { name, params, result } = req.body || {};
  if (!result || !Array.isArray(result.conflicts)) {
    return res.status(400).json({ error: '缺少有效的分析结果（result.conflicts）' });
  }
  const record = {
    id: crypto.randomUUID(),
    name: String(name || `分析 ${new Date().toLocaleString('zh-CN')}`),
    savedAt: new Date().toISOString(),
    params: params || result.params || {},
    result,
  };
  store.saveAnalysis(record);
  res.status(201).json(record);
});

// 列出已保存分析（不含大结果体，便于列表展示）
app.get('/api/analyses', (req, res) => {
  const list = store.listAnalyses().map(({ id, name, savedAt, params, result }) => ({
    id,
    name,
    savedAt,
    params,
    conflictCount: result.conflictCount,
    conflictCountByType: result.conflictCountByType || null,
    totalConflictAreaM2: result.totalConflictAreaM2,
  }));
  res.json({ analyses: list });
});

// 获取单个分析详情
app.get('/api/analyses/:id', (req, res) => {
  const record = store.getAnalysis(req.params.id);
  if (!record) return res.status(404).json({ error: '分析不存在' });
  res.json(record);
});

// 删除已保存分析
app.delete('/api/analyses/:id', (req, res) => {
  const removed = store.deleteAnalysis(req.params.id);
  res.status(removed ? 204 : 404).end();
});

// 导出 GeoJSON 报告（相交区域 + 冲突类型 + 共享资源 + 建议）
app.get('/api/analyses/:id/export', (req, res) => {
  const record = store.getAnalysis(req.params.id);
  if (!record) return res.status(404).json({ error: '分析不存在' });

  // 纯资源冲突无空间相交几何，导出为 null geometry 的 Feature 以保留完整冲突清单
  const features = record.result.conflicts.map((c) => ({
    type: 'Feature',
    geometry: c.geometry || null,
    properties: {
      conflictId: c.id,
      conflictType: c.conflictType,
      zones: c.zones.map((z) => z.name).join(' ∩ '),
      zoneDetails: c.zones,
      sharedResources: c.sharedResources || [],
      overlapStart: c.overlapStart,
      overlapEnd: c.overlapEnd,
      overlapDays: c.overlapDays,
      areaM2: c.areaM2,
      areaHectares: c.areaHectares,
      suggestions: c.suggestions.map((s) => s.text),
    },
  }));

  const report = {
    type: 'FeatureCollection',
    metadata: {
      title: record.name,
      exportedAt: new Date().toISOString(),
      generatedAt: record.result.generatedAt,
      params: record.params,
      conflictCount: record.result.conflictCount,
      conflictCountByType: record.result.conflictCountByType || null,
      totalConflictAreaM2: record.result.totalConflictAreaM2,
    },
    features,
  };

  const filename = `conflict-report-${record.id}.geojson`;
  res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(report, null, 2));
});

// SPA 兜底
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`施工区域冲突分析台已启动: http://localhost:${PORT}`);
});
