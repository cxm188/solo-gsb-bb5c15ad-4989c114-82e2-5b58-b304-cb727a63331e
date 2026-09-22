# 临时施工区域冲突分析台

一个 Node.js/Express Web 应用：导入带生效起止时间与资源占用的 GeoJSON 多边形施工区域，基于 [polygon-clipping](https://www.npmjs.com/package/polygon-clipping) 计算**同一时段内真实相交**的区域（空间冲突），并检测**同一时段占用同一资源**的区域（资源冲突）；两者同时满足时合并为一条记录并标注冲突类型、共享资源与重叠时段。结果按重叠面积降序输出，支持按冲突类型筛选，并自动生成可行的错峰/资源调配建议。支持图层筛选、分析结果保存与 GeoJSON 报告导出。

## 功能

- **质量预检 + 规范化（导入前置，独立流程）**：导入前逐要素检查环闭合、顶点数量、自相交、时间字段与资源字段；问题分**错误（不可导入）**与**警告（可自动规范化）**两级，每条带 [JSONPath](https://datatracker.ietf.org/wg/jsonpath/) 定位（如 `$.features[0].geometry.coordinates[0][3]`）。可修复问题（未闭合环、多余闭合点/重复顶点、资源分隔字符串、资源重复/空白、非标准日期、时间别名键、缺名称/图层）生成**规范化预览**，用户在预检结果页勾选确认后才写入区域库；支持「只导入通过项」与下载规范化 GeoJSON。提交接口在服务端再次复检，绕过前端无法写入脏数据
- **GeoJSON 导入**：支持 `FeatureCollection` / 单个 `Feature`，文件上传或文本粘贴；要素需带 `properties.start` / `properties.end`（ISO 日期），可选 `properties.resources`（字符串数组，如 `["塔吊", "挖掘机"]`）
- **空间冲突检测**：先判断时间窗口重叠，再用 polygon-clipping 对多边形做真实求交（支持 Polygon / MultiPolygon、带孔多边形），面积按局部等距投影计算（m²/公顷）
- **共享资源冲突检测**：时间重叠且 `resources` 存在交集即判定资源冲突；与空间冲突同时成立时合并为一条 `both` 记录，避免重复计数
- **结果筛选与建议**：按冲突类型（空间 / 资源 / 空间+资源）筛选结果列表；每处冲突给出"顺延 / 提前 / 工序穿插"建议，涉及共享资源时额外给出"资源错峰 / 分时复用 / 增配资源"建议（含具体调整日期与天数）
- **图层筛选**：按 `properties.layer` 勾选参与分析的图层，可限定分析时段（重叠期自动按时段裁剪）
- **地图可视化**：Leaflet 地图展示各区域（按图层着色）与按冲突类型着色的相交区域，点击结果可定位（纯资源冲突无相交几何，不上图）
- **保存与导出**：分析结果可命名保存（JSON 文件持久化），一键导出带元数据、冲突类型、共享资源与建议的 GeoJSON 报告

## 快速开始

### 方式一：Docker Compose（推荐）

```bash
docker compose up -d --build
```

### 方式二：本地 Node.js（≥ 18）

```bash
npm install
npm start
```

启动后浏览器访问 **http://localhost:3000** ，点击「加载示例」→「质量预检」→在结果页确认「导入选中项」→「运行冲突分析」即可看到完整流程（示例数据同时包含空间冲突、资源冲突与两者合并的情形）。点击「加载问题示例」可体验预检对未闭合环、自相交、顶点不足、日期/资源问题的分级拦截与自动修复。

### 导入流程（预检 → 确认 → 写入）

1. 选择/粘贴 GeoJSON 后点击「**质量预检**」（只检不写，区域库不变）
2. 预检结果页展示汇总（通过数 / 错误数 / 警告数 / 自动修复数）与逐要素明细：
   - **错误（红）**：自相交、顶点不足、坐标非法、时间缺失/非法/起止倒置、几何类型不支持等 → 不可勾选导入，需人工修复源数据
   - **警告（黄，可自动规范化）**：未闭合环、多余闭合点/连续重复点、资源分隔字符串、资源重复/空白、非标准日期、时间别名键、缺名称/图层 → 已在预览中修复，可直接导入
   - 每条问题标注 JSONPath，可据此回到源文件定位
3. 勾选要导入的通过项（错误项自动禁用），点击「**导入选中项**」（服务端复检后才写入），或「**下载规范化 GeoJSON**」存档/二次处理

### 运行测试

```bash
npm test
```

## 输入数据格式

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "name": "基坑开挖区 A",
        "layer": "土建",
        "start": "2026-10-01",
        "end": "2026-11-15",
        "resources": ["塔吊", "混凝土泵车"]
      },
      "geometry": { "type": "Polygon", "coordinates": [[[121.47, 31.228], [121.474, 31.228], [121.474, 31.231], [121.47, 31.231], [121.47, 31.228]]] }
    }
  ]
}
```

- `name`：区域名称（缺省自动命名）
- `layer`：图层名（缺省为「默认图层」），用于筛选与地图着色
- `start` / `end`：生效起止时间（也兼容 `startTime`/`endTime`、`from`/`to`），结束必须晚于开始
- `resources`：占用资源清单，**字符串数组**（如 `["塔吊", "挖掘机"]`）；也兼容逗号/顿号分隔的单个字符串，缺省为 `[]`。导入时自动去空白、去重
- 几何仅支持 `Polygon` / `MultiPolygon`

## 冲突类型与输出字段

分析结果中每条冲突包含：

| 字段 | 说明 |
| --- | --- |
| `conflictType` | `spatial`（时间重叠+空间相交）/ `resource`（时间重叠+共享资源）/ `both`（两者同时满足，合并为一条） |
| `sharedResources` | 双方共同占用的资源数组（纯空间冲突为 `[]`） |
| `overlapStart` / `overlapEnd` / `overlapDays` | 重叠时段（按分析时段裁剪后） |
| `areaM2` / `areaHectares` / `geometry` | 相交面积与相交几何；纯资源冲突无空间相交，`geometry` 为 `null`、面积为 0 |
| `suggestions` | 错峰建议列表（含资源错峰/分时复用/增配资源，每条含 `type` 与 `text`） |

汇总字段 `conflictCountByType` 给出三种类型各自的数量；保存的分析与导出的 GeoJSON 报告均完整保留以上字段（导出时纯资源冲突以 `geometry: null` 的 Feature 表示，保证冲突清单不丢失）。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/zones` | 列出全部区域（含 `resources`） |
| POST | `/api/zones/precheck` | **质量预检（只检不写）**：返回逐要素 error/warning（含 JSONPath）与规范化预览 |
| POST | `/api/zones/commit` | **确认后写入**：body `{geojson, indexes?}`；服务端重新预检，含错误要素返回 422 整批拒绝 |
| POST | `/api/zones/import` | 直接导入（兼容接口，脚本/CLI 用；网页端已改走预检流程） |
| DELETE | `/api/zones/:id` | 删除区域 |
| DELETE | `/api/zones` | 清空区域 |
| GET | `/api/layers` | 图层列表 |
| POST | `/api/analyze` | 运行分析，body：`{layers?, start?, end?}` |
| POST | `/api/analyses` | 保存分析，body：`{name?, params?, result}` |
| GET | `/api/analyses` | 已保存分析列表（含 `conflictCountByType`） |
| GET | `/api/analyses/:id` | 分析详情 |
| DELETE | `/api/analyses/:id` | 删除分析 |
| GET | `/api/analyses/:id/export` | 导出 GeoJSON 报告（附件下载，含冲突类型与共享资源） |

### 预检检查项与分级

| 检查项 | 级别 | 代码 | 可否自动修复 |
| --- | --- | --- | --- |
| 几何类型不是 Polygon/MultiPolygon、geometry/properties 缺失 | 错误 | `geometry-type-unsupported` 等 | 否 |
| 环顶点不是数值坐标（NaN/空值）、环/面结构非法 | 错误 | `ring-invalid-position` / `polygon-invalid` | 否 |
| 线性环不足 4 个位置 / 有效顶点不足 3 个 | 错误 | `ring-too-few-vertices` / `ring-degenerate` | 否 |
| 环自相交（非相邻边交叉/接触、非相邻顶点重合，如蝴蝶结） | 错误 | `ring-self-intersection` | 否（请人工修复） |
| 时间缺失 / 无法解析 / 结束不晚于开始 | 错误 | `time-missing` / `time-invalid` / `time-range` | 否 |
| 环未闭合 | 警告 | `ring-not-closed` | ✅ 自动补点闭合 |
| 多余闭合点、连续重复顶点 | 警告 | `ring-duplicate-closure` / `ring-duplicate-vertex` | ✅ 去重 |
| 坐标超出经纬度有效范围 | 警告 | `ring-coordinate-out-of-range` | 否（提示确认坐标系） |
| 时间使用别名键（`startTime`/`from` 等）、非标准日期格式（`2026/10/01`、`2026年10月1日`、时间戳等） | 警告 | `time-alias-key` / `time-format` | ✅ 统一为 `start`/`end` + ISO 8601(UTC) |
| 资源为分隔字符串、重复、带空白、含非文本条目、类型错误 | 警告 | `resource-string-split` / `resource-duplicate` 等 | ✅ 拆分、去重、去空白、剔除 |
| 缺 `name` / `layer` | 警告 | `name-missing` / `layer-missing` | ✅ 自动命名 / 归入默认图层 |

规范化动作：环统一为显式闭合且无重复点（保留第三维高程）；`start`/`end` 统一为 ISO 8601（UTC），移除时间别名键；`resources` 统一为去重去空白的字符串数组。`YYYY-MM-DD` 与带时区 ISO 8601 视为标准写法，不会产生警告。

## 项目结构

```
├── server.js            # Express 入口与 API 路由（precheck / commit / import / analyze）
├── src/
│   ├── analysis.js      # 时空/资源冲突检测与错峰建议生成
│   ├── quality.js       # 导入质量预检与规范化（环/顶点/自相交/时间/资源，JSONPath 定位）
│   ├── geo.js           # 局部投影与面积计算
│   └── store.js         # JSON 文件持久化（区域 / 已保存分析）
├── public/              # 前端（Leaflet 地图 + 分析面板 + 预检结果页）
│   ├── sample.geojson   # 示例数据（含 resources 字段）
│   └── sample-issues.geojson # 问题示例（各类错误/警告）
├── test/analysis.test.js
├── test/quality.test.js
├── Dockerfile
└── docker-compose.yml
```

## 说明

- 数据持久化在 `DATA_DIR`（默认 `./data`，容器内 `/app/data`，Compose 已挂载命名卷）
- 面积采用以相交区域质心为原点的局部等距圆柱投影近似，适用于施工场地尺度（公里级）的冲突评估
- 仅边界相接（零面积接触）不计为空间冲突
- 资源冲突只要求"时间重叠 + 资源同名"，与空间位置无关；资源名比较为精确匹配（导入时已做去空白处理），建议统一命名口径（如统一用「塔吊」而非「塔吊/塔式起重机」混用）
