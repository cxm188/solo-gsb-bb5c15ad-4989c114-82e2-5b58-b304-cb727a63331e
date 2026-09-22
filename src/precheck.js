'use strict';

/**
 * GeoJSON 导入质量预检与规范化。
 *
 * 逐要素检查：环闭合、顶点数量、自相交、时间字段、资源字段；
 * 问题区分 error（阻断导入）与 warning（可导入但提示），并给出 JSONPath 定位。
 * 对可自动修复的问题（补闭合点 / 去除重复顶点、资源拆分去重、日期格式统一）
 * 生成规范化要素预览，由用户确认后才写入区域库。
 */

const { normalizeResources } = require('./analysis');

const SEVERITY = { ERROR: 'error', WARNING: 'warning' };
const STATUS = { VALID: 'valid', WARNING: 'warning', ERROR: 'error' };

/** 从导入接口支持的多种形态中提取要素列表，并给出每个要素的 JSONPath 基路径 */
function extractFeatures(body) {
  if (body && body.type === 'FeatureCollection' && Array.isArray(body.features)) {
    return { features: body.features, basePath: (i) => `$.features[${i}]` };
  }
  if (body && body.type === 'Feature') {
    return { features: [body], basePath: () => '$' };
  }
  if (Array.isArray(body)) {
    return { features: body, basePath: (i) => `$[${i}]` };
  }
  throw new Error('请求体必须是 GeoJSON FeatureCollection 或 Feature');
}

function samePos(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function isValidPosition(p) {
  return Array.isArray(p) && p.length >= 2 &&
    Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

function inLonLatRange(p) {
  return p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90;
}

/** 叉积：向量 OA × OB */
function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function onSegment(p, a, b) {
  return cross(a, b, p) === 0 &&
    Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
}

/** 线段 AB 与 CD 是否 proper 相交（含端点落在对方线段上 / 共线重叠） */
function segmentsIntersect(a, b, c, d) {
  const c1 = cross(a, b, c);
  const c2 = cross(a, b, d);
  const c3 = cross(c, d, a);
  const c4 = cross(c, d, b);
  if (((c1 > 0 && c2 < 0) || (c1 < 0 && c2 > 0)) &&
      ((c3 > 0 && c4 < 0) || (c3 < 0 && c4 > 0))) {
    return true;
  }
  return (c1 === 0 && onSegment(c, a, b)) ||
         (c2 === 0 && onSegment(d, a, b)) ||
         (c3 === 0 && onSegment(a, c, d)) ||
         (c4 === 0 && onSegment(b, c, d));
}

/** 鞋带公式求环面积符号（经纬度平面近似，仅用于判定环绕方向） */
function ringSignedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/**
 * 检查并规范化单个线性环。
 * @returns {{errors: Array, warnings: Array, fixes: Array, normalized: Array|null}}
 */
function checkRing(ring, ringPath, isHole) {
  const errors = [];
  const warnings = [];
  const fixes = [];

  if (!Array.isArray(ring) || ring.length === 0) {
    errors.push({ code: 'invalid-ring', path: ringPath, message: '环坐标必须是非空数组' });
    return { errors, warnings, fixes, normalized: null };
  }

  // 1. 逐顶点合法性
  ring.forEach((p, k) => {
    if (!isValidPosition(p)) {
      errors.push({
        code: 'invalid-coordinate',
        path: `${ringPath}[${k}]`,
        message: `第 ${k + 1} 个顶点不是有效的 [经度, 纬度] 数值对`,
      });
    } else if (!inLonLatRange(p)) {
      errors.push({
        code: 'coordinate-out-of-range',
        path: `${ringPath}[${k}]`,
        message: `第 ${k + 1} 个顶点 (${p[0]}, ${p[1]}) 超出经纬度取值范围`,
      });
    }
  });
  if (errors.length) return { errors, warnings, fixes, normalized: null };

  // 2. 顶点数量：至少 3 个点才可能构成面（规范化补闭合点后需达到 4 个位置）
  if (ring.length < 3) {
    errors.push({
      code: 'too-few-vertices',
      path: ringPath,
      message: `环仅有 ${ring.length} 个顶点，多边形环至少需要 3 个不同顶点`,
    });
    return { errors, warnings, fixes, normalized: null };
  }

  // 3. 去除连续重复顶点（含末尾重复的闭合点，仅保留一个）
  const deduped = [];
  let removedDup = 0;
  for (const p of ring) {
    if (deduped.length && samePos(deduped[deduped.length - 1], p)) {
      removedDup += 1;
    } else {
      deduped.push(p);
    }
  }
  if (removedDup > 0) {
    warnings.push({
      code: 'duplicate-vertex',
      path: ringPath,
      message: `存在 ${removedDup} 个连续重复顶点（含重复闭合点），规范化时已去除`,
      fixable: true,
    });
    fixes.push({
      code: 'remove-duplicate-vertices',
      path: ringPath,
      message: `去除 ${removedDup} 个连续重复顶点`,
      before: { vertexCount: ring.length },
      after: { vertexCount: deduped.length + (samePos(deduped[0], deduped[deduped.length - 1]) ? 0 : 1) },
    });
  }

  // 4. 环闭合：首尾必须一致，否则在末尾补入首点
  let normalized = deduped;
  if (!samePos(deduped[0], deduped[deduped.length - 1])) {
    warnings.push({
      code: 'ring-not-closed',
      path: ringPath,
      message: '环未闭合（首尾点不一致），规范化时已在末尾补入首点',
      fixable: true,
    });
    fixes.push({
      code: 'close-ring',
      path: ringPath,
      message: '末尾补入首点使环闭合',
      before: deduped[deduped.length - 1].slice(0, 2),
      after: deduped[0].slice(0, 2),
    });
    normalized = deduped.concat([deduped[0]]);
  }

  // 5. 不同顶点数不足 3 个 → 退化几何
  const distinct = new Set(normalized.slice(0, -1).map((p) => `${p[0]},${p[1]}`));
  if (distinct.size < 3) {
    errors.push({
      code: 'degenerate-ring',
      path: ringPath,
      message: `环只有 ${distinct.size} 个不同顶点，无法构成有效多边形`,
    });
    return { errors, warnings, fixes, normalized: null };
  }

  // 6. 自相交 / 自接触：在去重闭合后的逻辑顶点（不含末尾重复点）上两两检查非相邻边
  const verts = normalized.slice(0, -1);
  const m = verts.length;
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === m - 1);
      if (adjacent) continue;
      const a = verts[i];
      const b = verts[(i + 1) % m];
      const c = verts[j];
      const d = verts[(j + 1) % m];
      if (samePos(a, c) || samePos(a, d) || samePos(b, c) || samePos(b, d) ||
          segmentsIntersect(a, b, c, d)) {
        errors.push({
          code: 'self-intersection',
          path: ringPath,
          message: `环存在自相交或自接触（第 ${i + 1} 段与第 ${j + 1} 段），请先在 GIS 工具中修复几何`,
          segments: [i, j],
        });
        return { errors, warnings, fixes, normalized: null };
      }
    }
  }

  // 7. 环绕方向（RFC 7946：外环逆时针、孔洞顺时针）；不阻断导入，仅提示
  const signed = ringSignedArea(normalized);
  const expectCCW = !isHole;
  const isCCW = signed > 0;
  if (isCCW !== expectCCW) {
    warnings.push({
      code: 'ring-orientation',
      path: ringPath,
      message: isHole
        ? '孔洞环方向不是 RFC 7946 推荐的顺时针方向，不影响分析'
        : '外环方向不是 RFC 7946 推荐的逆时针方向，不影响分析',
      fixable: false,
    });
  }

  return { errors, warnings, fixes, normalized };
}

/**
 * 检查并规范化几何。
 * @returns {{errors: Array, warnings: Array, fixes: Array, normalized: Object|null}}
 */
function checkGeometry(geometry, basePath) {
  const errors = [];
  const warnings = [];
  const fixes = [];

  if (!geometry || typeof geometry !== 'object') {
    errors.push({ code: 'missing-geometry', path: `${basePath}.geometry`, message: '缺少 geometry' });
    return { errors, warnings, fixes, normalized: null };
  }
  const { type, coordinates } = geometry;
  if (type !== 'Polygon' && type !== 'MultiPolygon') {
    errors.push({
      code: 'unsupported-geometry',
      path: `${basePath}.geometry.type`,
      message: `几何类型为 ${type || '未知'}，仅支持 Polygon / MultiPolygon`,
    });
    return { errors, warnings, fixes, normalized: null };
  }
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    errors.push({
      code: 'invalid-coordinates',
      path: `${basePath}.geometry.coordinates`,
      message: 'geometry.coordinates 缺失或为空',
    });
    return { errors, warnings, fixes, normalized: null };
  }

  // 统一成 MultiPolygon 结构遍历：polygons → rings
  const polygons = type === 'Polygon' ? [coordinates] : coordinates;
  const normPolygons = [];

  if (type === 'MultiPolygon' && polygons.some((poly) => !Array.isArray(poly) || poly.length === 0)) {
    errors.push({
      code: 'invalid-coordinates',
      path: `${basePath}.geometry.coordinates`,
      message: 'MultiPolygon 中存在空多边形或结构错误',
    });
    return { errors, warnings, fixes, normalized: null };
  }

  polygons.forEach((poly, pIdx) => {
    const normRings = [];
    poly.forEach((ring, rIdx) => {
      const ringPath = type === 'Polygon'
        ? `${basePath}.geometry.coordinates[${rIdx}]`
        : `${basePath}.geometry.coordinates[${pIdx}][${rIdx}]`;
      const result = checkRing(ring, ringPath, rIdx > 0);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
      fixes.push(...result.fixes);
      if (result.normalized) normRings.push(result.normalized);
    });
    normPolygons.push(normRings);
  });

  if (errors.length) return { errors, warnings, fixes, normalized: null };

  const normalized = {
    type,
    coordinates: type === 'Polygon' ? normPolygons[0] : normPolygons,
  };
  return { errors, warnings, fixes, normalized };
}

/**
 * 把多种日期写法统一为规范字符串：
 * - 纯日期（2026/10/1、2026年10月1日 等）→ YYYY-MM-DD
 * - 含时间的写法 → 完整 ISO 8601（UTC）
 * @returns {{ok: boolean, ms?: number, value?: string, changed?: boolean}}
 */
function unifyDate(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: false, missing: true };
  }
  const s = String(raw).trim();
  const m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})\s*日?$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const t = Date.parse(iso);
    // 排除 2026-02-31 这类被 Date 自动进位的伪日期
    const dt = new Date(t);
    if (Number.isNaN(t) || dt.getUTCFullYear() !== y ||
        dt.getUTCMonth() + 1 !== mo || dt.getUTCDate() !== d) {
      return { ok: false };
    }
    return { ok: true, ms: t, value: iso, changed: s !== iso };
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return { ok: false };
  const iso = new Date(t).toISOString();
  return { ok: true, ms: t, value: iso, changed: s !== iso };
}

/** 检查 properties 中的时间字段 */
function checkTime(props, basePath, fixes) {
  const errors = [];
  const warnings = [];
  const startKey = props.start !== undefined ? 'start'
    : props.startTime !== undefined ? 'startTime'
      : props.from !== undefined ? 'from' : null;
  const endKey = props.end !== undefined ? 'end'
    : props.endTime !== undefined ? 'endTime'
      : props.to !== undefined ? 'to' : null;

  if (!startKey) {
    errors.push({ code: 'missing-start', path: `${basePath}.properties.start`, message: '缺少生效开始时间（properties.start）' });
  }
  if (!endKey) {
    errors.push({ code: 'missing-end', path: `${basePath}.properties.end`, message: '缺少生效结束时间（properties.end）' });
  }
  if (!startKey || !endKey) return { errors, warnings, start: null, end: null };

  const startPath = `${basePath}.properties.${startKey}`;
  const endPath = `${basePath}.properties.${endKey}`;
  const s0 = unifyDate(props[startKey]);
  const e0 = unifyDate(props[endKey]);

  if (!s0.ok) {
    errors.push({ code: 'invalid-start', path: startPath, message: `开始时间无法解析：${String(props[startKey])}` });
  }
  if (!e0.ok) {
    errors.push({ code: 'invalid-end', path: endPath, message: `结束时间无法解析：${String(props[endKey])}` });
  }
  if (!s0.ok || !e0.ok) return { errors, warnings, start: null, end: null };

  if (e0.ms <= s0.ms) {
    errors.push({ code: 'invalid-time-range', path: `${basePath}.properties.end`, message: '结束时间必须晚于开始时间' });
    return { errors, warnings, start: null, end: null };
  }

  if (startKey !== 'start') {
    warnings.push({ code: 'time-field-alias', path: startPath, message: `时间字段使用了别名「${startKey}」，规范化时统一为 start`, fixable: true });
    fixes.push({ code: 'canonical-time-field', path: startPath, message: `字段 ${startKey} → start` });
  }
  if (endKey !== 'end') {
    warnings.push({ code: 'time-field-alias', path: endPath, message: `时间字段使用了别名「${endKey}」，规范化时统一为 end`, fixable: true });
    fixes.push({ code: 'canonical-time-field', path: endPath, message: `字段 ${endKey} → end` });
  }
  if (s0.changed) {
    warnings.push({ code: 'date-format', path: startPath, message: `开始时间「${props[startKey]}」已统一为 ${s0.value}`, fixable: true });
    fixes.push({ code: 'unify-date', path: startPath, message: '统一日期格式', before: props[startKey], after: s0.value });
  }
  if (e0.changed) {
    warnings.push({ code: 'date-format', path: endPath, message: `结束时间「${props[endKey]}」已统一为 ${e0.value}`, fixable: true });
    fixes.push({ code: 'unify-date', path: endPath, message: '统一日期格式', before: props[endKey], after: e0.value });
  }

  return { errors, warnings, start: s0.value, end: e0.value };
}

/** 检查 resources 字段并规范化 */
function checkResources(props, basePath) {
  const errors = [];
  const warnings = [];
  const fixes = [];
  const path = `${basePath}.properties.resources`;
  const raw = props.resources;

  if (raw === undefined || raw === null) {
    return { errors, warnings, fixes, resources: [] };
  }
  if (typeof raw === 'string') {
    warnings.push({ code: 'resources-not-array', path, message: 'resources 是分隔字符串而非字符串数组，规范化时已拆分', fixable: true });
  } else if (!Array.isArray(raw)) {
    warnings.push({ code: 'resources-not-array', path, message: `resources 类型为 ${typeof raw}，无法识别，规范化时清空`, fixable: true });
  } else if (raw.some((r) => typeof r !== 'string' && typeof r !== 'number')) {
    warnings.push({ code: 'resources-invalid-item', path, message: 'resources 中存在非字符串项，规范化时已剔除', fixable: true });
  }

  const normalized = normalizeResources(raw);

  if (Array.isArray(raw)) {
    const dupCount = raw.length - new Set(raw.map((r) => String(r).trim())).size;
    if (dupCount > 0) {
      warnings.push({ code: 'resources-duplicate', path, message: `resources 存在 ${dupCount} 个重复项，规范化时已去重`, fixable: true });
    }
    if (raw.some((r) => typeof r === 'string' && r !== r.trim())) {
      warnings.push({ code: 'resources-whitespace', path, message: 'resources 部分项含首尾空白，规范化时已去除', fixable: true });
    }
  }
  const beforeDesc = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const afterDesc = JSON.stringify(normalized);
  if (warnings.length || beforeDesc !== afterDesc) {
    fixes.push({ code: 'normalize-resources', path, message: '资源清单拆分 / 去空白 / 去重', before: raw, after: normalized });
  }
  return { errors, warnings, fixes, resources: normalized };
}

/** 预检单个要素 */
function precheckFeature(feature, index, basePath) {
  const bp = basePath(index);
  const errors = [];
  const warnings = [];
  const fixes = [];

  if (!feature || typeof feature !== 'object' || feature.type !== 'Feature') {
    return {
      index,
      name: `区域 ${index + 1}`,
      path: bp,
      status: STATUS.ERROR,
      importable: false,
      errors: [{ code: 'invalid-feature', path: bp, message: '不是有效的 GeoJSON Feature' }],
      warnings,
      fixes,
      normalized: null,
    };
  }

  const props = feature.properties && typeof feature.properties === 'object' ? feature.properties : {};
  if (!feature.properties || typeof feature.properties !== 'object') {
    warnings.push({
      code: 'missing-properties',
      path: `${bp}.properties`,
      message: '缺少 properties 对象，时间 / 资源字段将无法读取',
      fixable: false,
    });
  }

  const name = String(props.name || props.id || `区域 ${index + 1}`);
  if (props.name === undefined && props.id === undefined) {
    warnings.push({ code: 'missing-name', path: `${bp}.properties.name`, message: '缺少 name，规范化时自动命名', fixable: true });
    fixes.push({ code: 'default-name', path: `${bp}.properties.name`, message: '自动补全名称', after: name });
  }
  if (props.layer === undefined && props.group === undefined) {
    warnings.push({ code: 'missing-layer', path: `${bp}.properties.layer`, message: '缺少 layer，规范化时归入「默认图层」', fixable: true });
  }

  const geoResult = checkGeometry(feature.geometry, bp);
  errors.push(...geoResult.errors);
  warnings.push(...geoResult.warnings);
  fixes.push(...geoResult.fixes);

  const timeResult = checkTime(props, bp, fixes);
  errors.push(...timeResult.errors);
  warnings.push(...timeResult.warnings);

  const resResult = checkResources(props, bp);
  errors.push(...resResult.errors);
  warnings.push(...resResult.warnings);
  fixes.push(...resResult.fixes);

  const importable = errors.length === 0;
  let normalized = null;
  if (importable) {
    const normalizedProps = { ...props };
    normalizedProps.name = name;
    normalizedProps.layer = String(props.layer || props.group || '默认图层');
    normalizedProps.start = timeResult.start;
    normalizedProps.end = timeResult.end;
    normalizedProps.resources = resResult.resources;
    delete normalizedProps.startTime;
    delete normalizedProps.endTime;
    delete normalizedProps.from;
    delete normalizedProps.to;
    delete normalizedProps.group;
    normalized = { type: 'Feature', geometry: geoResult.normalized, properties: normalizedProps };
  }

  return {
    index,
    name,
    path: bp,
    status: errors.length ? STATUS.ERROR : warnings.length ? STATUS.WARNING : STATUS.VALID,
    importable,
    errors,
    warnings,
    fixes,
    normalized,
  };
}

/** 预检整份 GeoJSON */
function precheckGeoJSON(body) {
  const { features, basePath } = extractFeatures(body);

  const reports = features.map((f, i) => precheckFeature(f, i, basePath));
  const importableIndexes = [];
  const normalizedFeatures = [];
  reports.forEach((r) => {
    if (r.importable) {
      importableIndexes.push(r.index);
      normalizedFeatures.push(r.normalized);
    }
  });

  const summary = {
    total: reports.length,
    valid: reports.filter((r) => r.status === STATUS.VALID).length,
    withWarnings: reports.filter((r) => r.status === STATUS.WARNING).length,
    invalid: reports.filter((r) => r.status === STATUS.ERROR).length,
    importable: normalizedFeatures.length,
    errorCount: reports.reduce((n, r) => n + r.errors.length, 0),
    warningCount: reports.reduce((n, r) => n + r.warnings.length, 0),
    fixCount: reports.reduce((n, r) => n + r.fixes.length, 0),
  };

  return {
    checkedAt: new Date().toISOString(),
    summary,
    features: reports,
    normalized: { type: 'FeatureCollection', features: normalizedFeatures },
    importableIndexes,
  };
}

module.exports = {
  precheckGeoJSON,
  precheckFeature,
  extractFeatures,
  unifyDate,
  checkRing,
  SEVERITY,
  STATUS,
};
