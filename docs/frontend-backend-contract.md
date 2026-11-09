# 前后端契约

本文描述会话观察台当前代码实际提供的 HTTP API 和 SSE 协议，供前端开发、后端修改与联调使用。所有示例均使用合成数据；各接口示例可以来自不同场景，ID、路径、用量和提示文本不代表真实日志。

实现依据：

- [HTTP 路由与校验](../server/app.ts)
- [共享 TypeScript 类型](../shared/types.ts)
- [列表、筛选与分页](../server/store.ts)
- [日志解析与按需读取](../server/parser.ts)
- [上下文分析](../server/context-analysis.ts)、[分析任务调度](../server/context-service.ts)
- [索引事件](../server/index-worker.ts)、[索引服务](../server/indexer.ts)
- [前端请求封装](../client/api.ts)

## 通用约定

| 项目 | 约定 |
| --- | --- |
| API 基址 | 默认 `http://127.0.0.1:4317`；生产端口可由 `SESSION_LENS_PORT` 修改 |
| 开发访问 | 页面默认在 `http://127.0.0.1:5173`，通过 Vite 将 `/api` 代理至 `http://127.0.0.1:4317`；修改后端端口时需同步代理配置 |
| 编码与格式 | 普通接口返回 JSON，字段使用 camelCase；`PUT` 请求使用 `Content-Type: application/json` |
| 成功状态 | 本文列出的接口成功时均为 `200`；SSE 保持响应流打开 |
| 响应外层 | 直接返回业务对象，没有统一的 `data`、`code` 或 `success` 包装 |
| 请求体大小 | 上限为 `16 * 1024` 字节，即 16 KiB |
| 缓存 | 普通 `/api/` 响应设置 `Cache-Control: no-store`；SSE 使用单独的流响应头 |
| ID | `id` 为会话 ID，`turnId` 为轮次 ID，`requestId` 为模型调用 ID，`callId` 为工具调用 ID；均视为不透明字符串，放入路径时逐段使用 `encodeURIComponent` |
| 可选字段 | 共享类型中的 `?` 表示字段可能不出现；`null` 是有意义的未知值或结束标记，消费端不能一律换成 `0` |
| 时间 | 日志时间通常为 ISO 8601 字符串；缺失的事件或调用时间可能为 `""`。浏览器负责按本地时区展示，不应仅按时间戳重排日志顺序 |
| 分页 | `cursor`、`offset` 都是从 `0` 开始的位置，不是页码；下一页使用响应中的 `nextCursor` / `nextOffset`，为 `null` 时结束 |
| 字符偏移 | 工具输出分页和搜索定位以原始字符串的 UTF-16 code unit 计数；与 JavaScript 的 `length`、`slice` 一致，不是字节数或 Unicode 字符数 |
| 文件偏移 | `TurnSummary.startOffset` / `endOffset` 为 JSONL 文件的字节范围，区别于文本偏移 |

服务只监听 `127.0.0.1`。所有请求的 `Host` 必须为 `localhost` 或 `127.0.0.1`，可带端口；其他主机名返回 `403`。`/api/` 请求若带有 `Origin`，只允许 `http://<当前 Host>`、`http://127.0.0.1:5173` 和 `http://localhost:5173`。不带 `Origin` 的本机 HTTP 客户端可以访问。接口没有应用级登录或 Bearer token 鉴权，也没有配置通用跨域响应头，浏览器应通过页面同源地址请求。

参数表中的长度和范围来自当前路由 schema。合法的查询参数数字字符串会转换为数字；不要发送重复参数或依赖类型强制转换。未声明字段不是扩展契约：当前校验器会移除带 `additionalProperties: false` 的请求体或查询对象中的额外字段，其他查询 schema 不保证拒绝额外字段。

日志读取接口只读取已索引且仍位于所配置日志目录内的文件。`PUT /api/settings` 会修改本地设置并切换索引目录；本文其余接口不修改原始日志。

## 接口总览

| 方法 | 路径 | 用途 / 响应 |
| --- | --- | --- |
| GET | `/api/health` | 健康状态与 `IndexProgress` |
| GET | `/api/settings` | `AppSettings` |
| PUT | `/api/settings` | 切换日志目录，返回 `AppSettings` |
| GET | `/api/sessions` | `SessionList` |
| GET | `/api/sessions/:id` | `SessionDetail` |
| GET | `/api/sessions/:id/children` | `SessionChildrenPage` |
| GET | `/api/sessions/:id/activity` | `SessionActivity` |
| GET | `/api/sessions/:id/turns/:turnId` | `TurnDetail` |
| GET | `/api/sessions/:id/requests/:requestId/context` | `RequestContextAnalysis` |
| GET | `/api/sessions/:id/requests/:requestId/context/sources` | `ContextSourcePage` |
| GET | `/api/sessions/:id/requests/:requestId/comparison` | `RequestContextComparison` |
| GET | `/api/sessions/:id/compactions` | `CompactionPage` |
| GET | `/api/sessions/:id/tools/failures` | `ToolFailurePage` |
| GET | `/api/sessions/:id/tools/:callId/output` | `OutputPage` |
| GET | `/api/sessions/:id/search` | 工具参数与输出的匹配结果 |
| GET | `/api/events` | SSE 实时通知，见文末 |

## 共享数据模型

完整字段定义以 [shared/types.ts](../shared/types.ts) 为准。以下说明用于解释响应示例中的嵌套结构和语义。

### 用量、索引与设置

| 类型 | 字段 / 语义 |
| --- | --- |
| `TokenUsage` | `inputTokens`、`cachedInputTokens`、`cacheWriteInputTokens`、`outputTokens`、`reasoningOutputTokens`、`totalTokens`，均为数值 |
| `UsageSummary` | `tokens: TokenUsage \| null`、`requestCount: number`、`completeness: 'complete' \| 'partial' \| 'unknown'`、`latestInputTokens: number \| null`、`contextWindow: number \| null` |
| `RequestUsage` | `id`、`turnId`、`timestamp`、`usage: TokenUsage`、`source: 'record' \| 'snapshot-delta'`，可选 `model: string` 和 `contextWindow: number` |
| `IndexProgress` | `status: 'scanning' \| 'ready' \| 'error'`、`discovered`、`indexed`、`errors`，可选 `message: string` |
| `AppSettings` | `sessionsDir`、`defaultSessionsDir`、`dataDir`，均为服务端本机目录字符串 |

`cachedInputTokens` 和 `cacheWriteInputTokens` 是输入的子项，`reasoningOutputTokens` 是输出的子项，不能再次累加到总量。`totalTokens` 优先保留日志中的值，缺少时由输入与输出相加得到。数值经过归一化，缺失的用量子字段可能归一化为 `0`；完整性应结合 `completeness`、`source` 和 `warnings` 判断。

`source: 'record'` 表示直接用量记录；`snapshot-delta` 表示由累计快照推导的差值，可能覆盖多个缺失调用。`requestCount` 是可恢复记录数，不能保证等于实际请求数。`latestInputTokens` 是最近一次记录的输入量，不是会话累计输入或压缩后的精确上下文大小。父、子会话用量独立返回，不能在父会话用量上重复叠加子会话用量。

`IndexProgress.status: 'ready'` 表示扫描结束，仍可能有 `errors > 0`。`GET /api/health` 的 `ok: true` 只表示 HTTP 接口可响应，消费端还需检查 `progress`。

### 会话与轮次

| `SessionSummary` 字段 | 类型与含义 |
| --- | --- |
| `id`、`title` | `string`，会话标识与标题 |
| `cwd`、`project` | `string`，工作目录和展示名称；项目筛选使用 `cwd` |
| `model`、`source` | `string`，模型与日志来源 |
| `branch?` | `string`，日志记录的 Git 分支 |
| `startedAt`、`updatedAt` | `string`，开始时间与索引依据的文件更新时间 |
| `status` | `'running' \| 'completed' \| 'interrupted' \| 'unknown'` |
| `turnCount`、`toolCount` | `number`，轮次和工具调用数 |
| `toolFailureCount?` | `number`，最终记录为失败的工具调用数；当前解析器会提供，旧外部数据可能缺失 |
| `durationMs?` | `number \| null`，已记录时间戳的跨度，单位毫秒，不使用文件修改时间计算 |
| `compactionCount?` | `number`，压缩记录数 |
| `parentId?`、`agentName?`、`agentNickname?` | `string`，父会话、代理任务路径或名称、代理昵称 |
| `childCount?` | `number`，直接子会话数 |
| `filePath`、`fileSize` | `string`、`number`，服务端日志路径和文件字节数 |
| `revision` | `string`，当前文件版本标识，消费端只比较是否变化，不解析内部格式 |
| `usage`、`parseErrors` | `UsageSummary`、`number`，会话用量与跳过的损坏记录数 |
| `match?` | `{ turnId: string, excerpt: string }`，列表搜索命中的轮次与短摘要 |

| `TurnSummary` 字段 | 类型与含义 |
| --- | --- |
| `id`、`index` | `string`、`number`，轮次 ID 与从 `0` 开始的顺序 |
| `prompt`、`preview` | `string`，用户请求与轮次预览 |
| `startedAt`、`endedAt?` | `string`，开始时间和可选结束时间 |
| `status`、`model` | 与会话相同的状态枚举、`string` |
| `toolCount`、`toolFailureCount?`、`compactionCount?` | `number`，本轮的工具、失败与压缩计数 |
| `usage` | `UsageSummary`，本轮用量 |
| `startOffset`、`endOffset` | `number`，服务端 JSONL 字节范围，前端无需用其读取文件 |

### 时间线与工具

`TimelineEvent` 包含 `id`、`kind`、`timestamp`、`text`，以及可选 `noticeType: 'compaction'`、`tool: ToolCall`、`collaboration: CollaborationMessage`。

- `kind` 为 `user`、`assistant`、`commentary`、`context`、`reasoning`、`tool`、`collaboration`、`notice` 或 `unknown`。
- `CollaborationMessage` 包含 `messageType: 'NEW_TASK' | 'MESSAGE' | 'FINAL_ANSWER'`、`taskName`、`sender`、`payload`；后三者为字符串，`payload` 是完整消息正文。
- `ToolCall` 包含 `id`、`name`、`category`、`arguments`、`output`、`outputLength`、`outputTruncated`、`status` 和可选 `exitCode: number`。`arguments` 即使包含 JSON 也仍是字符串。
- `category` 为 `command`、`mcp`、`patch`、`web`、`agent` 或 `other`；工具 `status` 为 `running`、`completed`、`failed` 或 `unknown`。
- `outputLength` 是完整输出的 UTF-16 长度。轮次详情最多内联前 `16384` 个 UTF-16 code unit；`outputTruncated: true` 时通过输出分页接口读取其余内容。

### 上下文分析

| 分类 `ContextCategory` | 含义 |
| --- | --- |
| `userMessages` | 可见用户消息 |
| `projectInstructions` | 用户与项目指令 |
| `skills` | 可确认的技能说明 |
| `toolDefinitions` | 可见工具定义与 schema |
| `toolOutputs` | 输入边界前的工具返回 |
| `other` | 其他可见上下文 |

`ContextComponent` 包含 `id: ContextCategory`、`label: string`、`tokens: number | null`、`status: 'estimated' | 'partial' | 'unavailable'`、`method: 'tokenized' | 'sampled' | 'none'`、`items: number` 和 `note: string`。分析和对比固定按上表顺序返回六个分类；未知分类值为 `null`，不能当作零。

`ContextSource` 包含 `id`、`category`、`label`、`estimatedTokens`、`method: 'tokenized' | 'sampled'`、`partial: boolean`、`note`、`excerpt`，以及可选 `turnId`、`eventId`、`role`。`label` 最长 120、`excerpt` 最长 300 个 UTF-16 code unit。来源 ID 用于当前分析中的定位和对比，不是独立资源接口。

分析中的 `boundary` 为 `inferred` 或 `unavailable`；`scope` 为 `visible-history`、`since-compaction` 或 `unavailable`。这是日志候选上下文的本地文本估算，不是模型请求的完整输入快照，不读取当前磁盘上的指令替代历史记录，也不改变原始用量。

## HTTP 接口详情

### GET /api/health

无请求参数。响应：

```json
{
  "ok": true,
  "progress": { "status": "ready", "discovered": 1, "indexed": 1, "errors": 0 }
}
```

### GET /api/settings

无请求参数。返回 `AppSettings`：

```json
{
  "sessionsDir": "E:\\demo\\logs",
  "defaultSessionsDir": "C:\\Users\\demo\\.codex\\sessions",
  "dataDir": "C:\\Users\\demo\\AppData\\Local\\codex-session-lens"
}
```

### PUT /api/settings

| JSON 请求体字段 | 必填 | 类型 / 限制 |
| --- | --- | --- |
| `sessionsDir` | 是 | 字符串，长度 `1..4096`，应提交服务端本机可读取目录的完整路径 |

请求示例：

```json
{ "sessionsDir": "E:\\demo\\other-logs" }
```

后端用 `path.resolve` 解析路径，再检查目录与读取权限，并保存解析符号链接后的规范路径。相对路径实际相对于服务进程工作目录解析，前端应提交绝对路径以避免歧义。切换会启动该目录对应的索引；HTTP 成功不表示所有日志已扫描完毕，继续通过 `progress` 和 SSE 跟踪。切换或保存失败会尝试恢复原索引目录与设置。

成功响应仍为完整 `AppSettings`：

```json
{
  "sessionsDir": "E:\\demo\\other-logs",
  "defaultSessionsDir": "C:\\Users\\demo\\.codex\\sessions",
  "dataDir": "C:\\Users\\demo\\AppData\\Local\\codex-session-lens"
}
```

### GET /api/sessions

| 查询参数 | 必填 | 默认值 | 类型 / 限制 |
| --- | --- | --- | --- |
| `query` | 否 | 无筛选 | 字符串，最长 500；搜索前会去掉首尾空白 |
| `project` | 否 | 无筛选 | 字符串，最长 4096；精确匹配工作目录 `cwd`，不是项目展示名称 |
| `selectedId` | 否 | 无 | 字符串，最长 256；仅在没有有效搜索词和项目筛选时补充所选会话 |
| `cursor` | 否 | `0` | 整数，`0..10000000` |
| `limit` | 否 | `50` | 整数，`1..100` |

请求示例：`/api/sessions?query=marker&cursor=0&limit=50`。

按 `updatedAt` 降序、`id` 升序排序。搜索包括标题、工作目录、模型、会话 ID、代理任务名、昵称和已索引的消息文本；它与下文专门搜索完整工具参数及输出的 `/search` 接口不同。

返回 `SessionList`。`total` 是当前筛选下的会话总数；`ancestors` 补充树形展示需要、但不在当前 `items` 中的祖先，不计入分页；可选 `selected` 不受当前分页位置限制，未知 `selectedId` 不导致 `404`。`projects` 是整个索引的项目统计，不随当前筛选分页。

```json
{
  "items": [
    {
      "id": "session-demo",
      "title": "检查项目",
      "cwd": "E:\\demo",
      "project": "demo",
      "model": "example-model",
      "source": "codex_cli_rs",
      "startedAt": "2026-11-09T00:00:00.000Z",
      "updatedAt": "2026-11-09T00:00:05.000Z",
      "status": "completed",
      "turnCount": 1,
      "toolCount": 1,
      "toolFailureCount": 0,
      "durationMs": 5000,
      "compactionCount": 0,
      "childCount": 0,
      "filePath": "E:\\demo\\logs\\session-demo.jsonl",
      "fileSize": 2048,
      "revision": "example-revision",
      "usage": {
        "tokens": { "inputTokens": 1000, "cachedInputTokens": 200, "cacheWriteInputTokens": 0, "outputTokens": 100, "reasoningOutputTokens": 20, "totalTokens": 1100 },
        "requestCount": 1,
        "completeness": "complete",
        "latestInputTokens": 1000,
        "contextWindow": null
      },
      "parseErrors": 0,
      "match": { "turnId": "turn-demo", "excerpt": "请检查 marker" }
    }
  ],
  "ancestors": [],
  "total": 1,
  "nextCursor": null,
  "projects": [{ "name": "demo", "path": "E:\\demo", "count": 1 }],
  "progress": { "status": "ready", "discovered": 1, "indexed": 1, "errors": 0 }
}
```

### GET /api/sessions/:id

路径参数：`id`。无查询参数。返回 `SessionDetail`，包含本会话摘要、全部轮次摘要、全部直接子会话摘要，以及存在时的 `parent` 摘要。此接口不返回轮次正文；较大的子树可以使用 `/children` 逐层分页加载。

```json
{
  "session": {
    "id": "session-demo", "title": "检查项目", "cwd": "E:\\demo", "project": "demo",
    "model": "example-model", "source": "codex_cli_rs",
    "startedAt": "2026-11-09T00:00:00.000Z", "updatedAt": "2026-11-09T00:00:05.000Z",
    "status": "completed", "turnCount": 1, "toolCount": 1, "toolFailureCount": 0,
    "durationMs": 5000, "compactionCount": 0, "childCount": 0,
    "filePath": "E:\\demo\\logs\\session-demo.jsonl", "fileSize": 2048, "revision": "example-revision",
    "usage": {
      "tokens": { "inputTokens": 1000, "cachedInputTokens": 200, "cacheWriteInputTokens": 0, "outputTokens": 100, "reasoningOutputTokens": 20, "totalTokens": 1100 },
      "requestCount": 1, "completeness": "complete", "latestInputTokens": 1000, "contextWindow": null
    },
    "parseErrors": 0
  },
  "turns": [
    {
      "id": "turn-demo", "index": 0, "prompt": "检查项目", "preview": "已完成检查。",
      "startedAt": "2026-11-09T00:00:00.000Z", "endedAt": "2026-11-09T00:00:05.000Z",
      "status": "completed", "model": "example-model", "toolCount": 1, "toolFailureCount": 0, "compactionCount": 0,
      "usage": {
        "tokens": { "inputTokens": 1000, "cachedInputTokens": 200, "cacheWriteInputTokens": 0, "outputTokens": 100, "reasoningOutputTokens": 20, "totalTokens": 1100 },
        "requestCount": 1, "completeness": "complete", "latestInputTokens": 1000, "contextWindow": null
      },
      "startOffset": 200, "endOffset": 2048
    }
  ],
  "children": []
}
```

不存在或尚未索引的会话返回 `404`。索引中的摘要与当前文件读取并非同一快照，实时写入时可能短暂不一致。

### GET /api/sessions/:id/children

路径参数：父会话 `id`。

| 查询参数 | 必填 | 默认值 | 类型 / 限制 |
| --- | --- | --- | --- |
| `cursor` | 否 | `0` | 整数，`0..10000000` |
| `limit` | 否 | `50` | 整数，`1..100` |

返回 `SessionChildrenPage`，`items` 的元素为 `SessionSummary`，只包含直接子会话，按 `updatedAt` 降序、`id` 升序排序。父会话不存在返回 `404`，存在但没有子会话时：

```json
{ "items": [], "total": 0, "nextCursor": null }
```

### GET /api/sessions/:id/activity

路径参数：`id`。无查询参数。返回 `SessionActivity`，用于用量趋势和协作时序，不返回完整轮次或工具正文。

```json
{
  "requests": [
    {
      "id": "response-demo", "turnId": "turn-demo", "timestamp": "2026-11-09T00:00:04.000Z",
      "usage": { "inputTokens": 1000, "cachedInputTokens": 200, "cacheWriteInputTokens": 0, "outputTokens": 100, "reasoningOutputTokens": 20, "totalTokens": 1100 },
      "source": "record", "model": "example-model"
    }
  ],
  "compactions": [
    { "id": "notice-1500", "turnId": "turn-demo", "timestamp": "2026-11-09T00:00:03.000Z", "beforeRequestIndex": 0 }
  ],
  "messages": [
    { "id": "event-900", "turnId": "turn-demo", "timestamp": "2026-11-09T00:00:02.000Z", "messageType": "MESSAGE", "sender": "/root/check", "taskName": "/root", "preview": "检查完成。" }
  ],
  "warnings": []
}
```

`requests` 保持日志顺序。`compactions[].beforeRequestIndex` 是压缩发生前已恢复的调用记录数，不是轮次序号；无法确认归属时省略该项的 `turnId`。`messages[].preview` 是协作消息摘要，完整正文通过对应轮次中的 `TimelineEvent.collaboration.payload` 获取。日志不可用或会话不存在返回 `404`；不完整记录、缺失时间戳与继承重放前缀等限制通过 `warnings` 说明。

### GET /api/sessions/:id/turns/:turnId

路径参数：`id`、`turnId`。无查询参数。返回 `TurnDetail`：

```json
{
  "summary": {
    "id": "turn-demo", "index": 0, "prompt": "检查项目", "preview": "已完成检查。",
    "startedAt": "2026-11-09T00:00:00.000Z", "endedAt": "2026-11-09T00:00:05.000Z",
    "status": "completed", "model": "example-model", "toolCount": 1, "toolFailureCount": 0, "compactionCount": 0,
    "usage": {
      "tokens": { "inputTokens": 1000, "cachedInputTokens": 200, "cacheWriteInputTokens": 0, "outputTokens": 100, "reasoningOutputTokens": 20, "totalTokens": 1100 },
      "requestCount": 1, "completeness": "complete", "latestInputTokens": 1000, "contextWindow": null
    },
    "startOffset": 200, "endOffset": 2048
  },
  "events": [
    { "id": "event-300", "kind": "user", "timestamp": "2026-11-09T00:00:01.000Z", "text": "检查项目" },
    {
      "id": "tool-500", "kind": "tool", "timestamp": "2026-11-09T00:00:02.000Z", "text": "exec_command",
      "tool": {
        "id": "call-demo", "name": "exec_command", "category": "command", "arguments": "{\"cmd\":\"echo marker\"}",
        "output": "line1\nmarker\nline3", "outputLength": 18, "outputTruncated": false, "status": "completed", "exitCode": 0
      }
    },
    { "id": "event-1800", "kind": "assistant", "timestamp": "2026-11-09T00:00:05.000Z", "text": "已完成检查。" }
  ],
  "requests": [
    {
      "id": "response-demo", "turnId": "turn-demo", "timestamp": "2026-11-09T00:00:04.000Z",
      "usage": { "inputTokens": 1000, "cachedInputTokens": 200, "cacheWriteInputTokens": 0, "outputTokens": 100, "reasoningOutputTokens": 20, "totalTokens": 1100 },
      "source": "record", "model": "example-model"
    }
  ],
  "warnings": []
}
```

会话或文件不存在、`turnId` 不存在时返回 `404`。未知轮次的错误体为 `{ "message": "未找到此轮次。" }`。

### GET /api/sessions/:id/requests/:requestId/context

路径参数：`id`、`requestId`。

| 查询参数 | 必填 | 类型 / 限制 |
| --- | --- | --- |
| `turnId` | 是 | 字符串，长度 `1..256`，模型调用所属轮次 |

请求示例：`/api/sessions/session-demo/requests/response-demo/context?turnId=turn-demo`。

返回 `RequestContextAnalysis`；只包含数值、分类和分析依据，不附带用户消息或工具输出的原文。示例：

```json
{
  "requestId": "response-demo",
  "inputTokens": 1000,
  "tokenizer": "o200k_base",
  "boundary": "inferred",
  "scope": "visible-history",
  "components": [
    { "id": "userMessages", "label": "用户消息", "tokens": 100, "status": "estimated", "method": "tokenized", "items": 1, "note": "按已记录的用户文本估算，包含前面回合的可见消息。" },
    { "id": "projectInstructions", "label": "用户与项目指令", "tokens": 200, "status": "estimated", "method": "tokenized", "items": 1, "note": "仅统计日志明确标记的 AGENTS.md 或用户指令；未读取当前磁盘文件补推历史。" },
    { "id": "skills", "label": "Skills", "tokens": null, "status": "unavailable", "method": "none", "items": 0, "note": "输入边界前未找到可确认的记录，无法统计；不代表实际为零。" },
    { "id": "toolDefinitions", "label": "工具定义", "tokens": 300, "status": "estimated", "method": "tokenized", "items": 1, "note": "按已记录的工具说明和 schema 文本估算；模型侧工具序列化和延迟加载状态可能不同。" },
    { "id": "toolOutputs", "label": "工具输出", "tokens": 0, "status": "estimated", "method": "tokenized", "items": 0, "note": "输入边界前没有可见工具返回；估算为 0，仅适用于日志可见部分。" },
    { "id": "other", "label": "其他可见上下文", "tokens": 200, "status": "estimated", "method": "tokenized", "items": 1, "note": "包括可见基础与运行指令、历史助手消息、工具调用参数及其他可识别文本。" }
  ],
  "estimatedTotalTokens": 800,
  "unattributedTokens": 200,
  "excessTokens": 0,
  "warnings": [
    "这些是日志可见候选上下文的文本估算，不是请求原始快照；协议封装、指令替换、历史裁剪和服务端处理可能使其与实测输入不同。",
    "估算未归一化。正差仅用于对账，不是可精确归属的隐藏 token 成本；超出实测时仍保留原估算。",
    "o200k_base 是文本近似分词器，不保证与当前模型的实际分词和消息封装一致。"
  ]
}
```

`estimatedTotalTokens` 是可估分类之和；`unattributedTokens = inputTokens - estimatedTotalTokens`，允许为负；`excessTokens = max(0, estimatedTotalTokens - inputTokens)`。这些值不会回写或修改原始 `usage`。

`snapshot-delta` 或缺失调用边界时仍返回 `200`，但 `boundary`、`scope` 为 `unavailable`，六个分类的 `tokens`、`estimatedTotalTokens`、`unattributedTokens` 为 `null`，`excessTokens` 为 `0`，原因在 `warnings` 中。未知会话、轮次、调用或调用不属于指定轮次时返回 `404`。

### GET /api/sessions/:id/requests/:requestId/context/sources

路径参数：`id`、`requestId`。

| 查询参数 | 必填 | 默认值 | 类型 / 限制 |
| --- | --- | --- | --- |
| `turnId` | 是 | 无 | 字符串，长度 `1..256` |
| `category` | 是 | 无 | 上文六个 `ContextCategory` 枚举之一 |
| `offset` | 否 | `0` | 整数，`0..10000000` |
| `limit` | 否 | `20` | 整数，`1..50` |

请求示例：`/api/sessions/session-demo/requests/response-demo/context/sources?turnId=turn-demo&category=userMessages&offset=0&limit=20`。

返回 `ContextSourcePage`，在明确请求此接口后才返回候选来源短预览：

```json
{
  "requestId": "response-demo",
  "category": "userMessages",
  "sources": [
    {
      "id": "source-1", "category": "userMessages", "turnId": "turn-demo", "eventId": "event-300",
      "label": "用户消息", "role": "user", "estimatedTokens": 100, "method": "tokenized", "partial": false,
      "note": "按已记录的用户文本估算，包含前面回合的可见消息。", "excerpt": "检查项目"
    }
  ],
  "total": 1,
  "nextOffset": null,
  "boundary": "inferred",
  "scope": "visible-history",
  "warnings": ["这些是日志可见候选上下文的文本估算，不是请求原始快照；协议封装、指令替换、历史裁剪和服务端处理可能使其与实测输入不同。"]
}
```

`total` 仅统计所选分类；无法恢复边界时返回空 `sources`、`total: 0`、`nextOffset: null` 和相应限制说明，仍是 `200`。超长来源可按样本外推，`method: 'sampled'`；`partial` 标记来源或可见历史不完整。

### GET /api/sessions/:id/requests/:requestId/comparison

路径参数：`id`、`requestId`。

| 查询参数 | 必填 | 类型 / 限制 |
| --- | --- | --- |
| `turnId` | 是 | 字符串，长度 `1..256` |

返回 `RequestContextComparison`。比较对象是同一会话日志顺序中的前一条可恢复调用，可跨轮次；不是按时间排序、不是上一轮的最后一条，也不接受前端指定比较对象。

```json
{
  "current": {
    "id": "response-two", "turnId": "turn-two", "timestamp": "2026-11-09T00:00:10.000Z",
    "usage": { "inputTokens": 1200, "cachedInputTokens": 300, "cacheWriteInputTokens": 0, "outputTokens": 80, "reasoningOutputTokens": 10, "totalTokens": 1280 },
    "source": "record"
  },
  "previous": {
    "id": "response-one", "turnId": "turn-one", "timestamp": "2026-11-09T00:00:04.000Z",
    "usage": { "inputTokens": 1000, "cachedInputTokens": 200, "cacheWriteInputTokens": 0, "outputTokens": 100, "reasoningOutputTokens": 20, "totalTokens": 1100 },
    "source": "record"
  },
  "comparable": true,
  "components": [
    { "id": "userMessages", "label": "用户消息", "currentTokens": 100, "previousTokens": 100, "deltaTokens": 0 },
    { "id": "projectInstructions", "label": "用户与项目指令", "currentTokens": 200, "previousTokens": 200, "deltaTokens": 0 },
    { "id": "skills", "label": "Skills", "currentTokens": null, "previousTokens": null, "deltaTokens": null },
    { "id": "toolDefinitions", "label": "工具定义", "currentTokens": 300, "previousTokens": 300, "deltaTokens": 0 },
    { "id": "toolOutputs", "label": "工具输出", "currentTokens": 100, "previousTokens": 0, "deltaTokens": 100 },
    { "id": "other", "label": "其他可见上下文", "currentTokens": 200, "previousTokens": 200, "deltaTokens": 0 }
  ],
  "changes": {
    "added": 1, "removed": 0, "changed": 0,
    "addedSources": [
      { "id": "source-5", "category": "toolOutputs", "turnId": "turn-one", "eventId": "tool-500", "label": "工具输出", "estimatedTokens": 100, "method": "tokenized", "partial": false, "note": "仅统计输入边界前的可见工具返回；混合输出继续归工具输出，不按关键词拆分。", "excerpt": "marker" }
    ],
    "removedSources": [], "changedSources": []
  },
  "warnings": ["这些是日志可见候选上下文的文本估算，不是请求原始快照；协议封装、指令替换、历史裁剪和服务端处理可能使其与实测输入不同。"]
}
```

只有两次调用的输入边界均可恢复且没有跨压缩范围时，`comparable` 才为 `true`。首条调用的 `previous` 为 `null`。不具备比较条件时仍返回原始用量，所有 `deltaTokens` 为 `null`，来源变化计数为 `0`、来源数组为空，并给出 `warnings`；即使 `comparable: true`，任一侧分类未知时该分类差值仍为 `null`。

`changes.added`、`removed`、`changed` 是完整变化计数；三个 `*Sources` 数组各最多返回 5 条预览，不是可分页的完整列表。`changedSources` 仅包含本次版本，不返回全文差异。

### GET /api/sessions/:id/compactions

路径参数：`id`。

| 查询参数 | 必填 | 默认值 | 类型 / 限制 |
| --- | --- | --- | --- |
| `offset` | 否 | `0` | 整数，最小 `0`，路由未设置最大值 |
| `limit` | 否 | `20` | 整数，`1..100` |

返回 `CompactionPage`，仅提供按日志顺序排列的压缩导航位置，不返回压缩正文：

```json
{
  "items": [
    { "turnId": "turn-demo", "eventId": "notice-1500", "timestamp": "2026-11-09T00:00:03.000Z" }
  ],
  "total": 1,
  "nextOffset": null
}
```

这里的 `turnId` 是可用于导航的轮次；不一定等同于 `/activity` 中可确认的压缩归属。使用该 `turnId` 加载轮次，再按 `eventId` 定位。越过末尾返回空 `items` 和 `nextOffset: null`。

### GET /api/sessions/:id/tools/failures

路径参数：`id`。

| 查询参数 | 必填 | 默认值 | 类型 / 限制 |
| --- | --- | --- | --- |
| `offset` | 否 | `0` | 整数，最小 `0`，路由未设置最大值 |
| `limit` | 否 | `20` | 整数，`1..100` |

返回 `ToolFailurePage`，按轮次与事件顺序提供最终工具状态为 `failed` 的定位信息，不返回参数、输出或错误正文：

```json
{
  "items": [
    { "turnId": "turn-demo", "eventId": "tool-500", "toolId": "call-demo", "toolName": "exec_command" }
  ],
  "total": 1,
  "nextOffset": null
}
```

通过 `turnId` 获取轮次，再按 `eventId` / `toolId` 查看工具详情。`total` 来自会话的最终失败计数；工具输出修正后的最终状态用于去重计数，不能把中间错误文本的出现次数当作失败次数。越过末尾返回空 `items`。

### GET /api/sessions/:id/tools/:callId/output

路径参数：`id`、`callId`。

| 查询参数 | 必填 | 默认值 | 类型 / 限制 |
| --- | --- | --- | --- |
| `offset` | 否 | `0` | 整数，最小 `0`；UTF-16 code unit 位置，路由未设置最大值 |
| `limit` | 否 | `16384` | 整数，`1..65536`；单页 UTF-16 code unit 数 |

请求示例：`/api/sessions/session-demo/tools/call-demo/output?offset=6&limit=6`。假设完整输出为 `"line1\nmarker\nline3"`，返回 `OutputPage`：

```json
{ "text": "marker", "offset": 6, "nextOffset": 12, "totalLength": 18 }
```

`text` 是原始输出的 `slice(offset, offset + limit)`；`totalLength` 为完整输出长度，结束时 `nextOffset: null`。`offset` 越过末尾时返回空 `text`，仍保留所请求的 `offset` 和完整长度。分页切点可能落在代理对中间，需要消费端正确处理文本拼接。

会话不存在、`callId` 不存在或工具尚未产生输出记录时返回 `404`；未知或尚无记录的工具输出错误体为 `{ "message": "未找到工具输出。" }`。读取期间对应输出记录已变化、原位置不再包含该输出时也返回 `404`，说明为 `工具输出记录已变更，请刷新会话。`。已经记录的空输出是有效资源，返回 `200`、`text: ""`、`totalLength: 0`、`nextOffset: null`，与尚无输出记录不同。

### GET /api/sessions/:id/search

路径参数：`id`。

| 查询参数 | 必填 | 类型 / 限制 |
| --- | --- | --- |
| `query` | 是 | 字符串，长度 `1..500`；不去掉首尾空白，按字面量查找 |

请求示例：`/api/sessions/session-demo/search?query=marker`。只搜索本会话工具调用的完整 `arguments` 和完整 `output`，包括轮次详情内联上限以外的输出；不搜索普通用户或助手消息，不递归搜索子会话。

匹配时使用 `toLowerCase()` 做大小写折叠，支持重叠匹配，不把查询当作正则表达式。结果按轮次、工具事件、`arguments` 再 `output`、字段内偏移排序，最多返回 100 条；只有确实还存在第 101 条匹配时才返回 `truncated: true`。没有分页参数。

```json
{
  "matches": [
    {
      "turnId": "turn-demo", "eventId": "tool-500", "toolId": "call-demo", "toolName": "exec_command",
      "field": "output", "offset": 6, "length": 6, "matchedText": "marker",
      "text": "line1\nmarker\nline3", "excerptOffset": 0
    }
  ],
  "truncated": false
}
```

`matches` 的元素为 `ToolSearchMatch`。`offset`、`length` 指向原始字段中的 UTF-16 范围，大小写折叠改变字符串长度时仍映射回原文。`matchedText` 是原文匹配内容，`text` 是附近摘要，`excerptOffset` 是摘要在原字段中的起点；当前后端会提供该起点，共享类型为兼容旧数据将其标为可选。摘要通常保留匹配前 70、后 160 个 UTF-16 code unit，并调整边缘以避免切断代理对。前端可用 `offset - excerptOffset` 定位摘要中的匹配。

没有匹配时返回 `{ "matches": [], "truncated": false }`；会话不存在返回 `404`，缺少或空查询返回 `400`。

## 错误约定

普通 HTTP 错误通过非 `2xx` 状态码表达，响应体为：

```json
{ "message": "未找到此会话，可能仍在索引中。" }
```

当前没有稳定的业务错误码、字段级错误数组或统一重试标记。消费端以 HTTP 状态码分流，用 `message` 展示说明，不应解析中文文案或校验器英文文案来判断业务类型。`warnings` 是成功结果中的数据限制说明，不表示 HTTP 请求失败。

| HTTP 状态 | 当前触发场景 | 响应 `message` 示例 |
| --- | --- | --- |
| `400` | 请求体或查询校验失败、无效 JSON、日志目录不存在或不可读 | `querystring/limit must be >= 1`；`目录不存在或无法读取，请填写日志目录的完整路径。` |
| `403` | 非本机 `Host`、不允许的 `Origin`、文件真实路径越出日志根目录 | `请通过本机 localhost 或 127.0.0.1 访问。`；`此接口仅允许本机应用页面访问。`；`日志路径超出已设置的目录。` |
| `404` | 未知 API、会话或父会话不存在、日志文件不存在、轮次不存在、模型调用不存在 / 归属不符、工具输出尚未记录或已不存在 | `接口不存在。`；`未找到此父会话。`；`未找到此轮次。`；`未找到此轮次中的模型调用。`；`未找到工具输出。` |
| `413` | 请求体超过 16 KiB | `Request body is too large` |
| `415` | 请求体使用不支持的媒体类型 | `Unsupported Media Type` |
| `429` | 上下文分析已有至少 8 个未完成任务，拒绝新增分析、来源或对比任务 | `正在分析多个调用，请稍后重试。` |
| `500` | 解析、索引、文件读写或保存等内部故障 | `读取日志时发生错误，请稍后重试。` |
| `504` | 上下文分析任务超过 60 秒 | `读取日志时发生错误，请稍后重试。` |

所有经过统一错误处理器的 `5xx` 响应都会使用上表的通用错误说明，因此 `504` 也不会向客户端暴露内部超时文本。`/api/...` 未匹配路由返回 JSON `404`；非 API 路径未找到时可能返回纯文本，不属于本契约的 JSON 接口。

[client/api.ts](../client/api.ts) 与后端统一使用 `message`：非成功响应中的 `message` 为非空字符串时，前端抛出保留该说明的 `Error`；响应不是有效 JSON、没有 `message`、其类型不是字符串或只包含空白时，回退为 `请求失败 (<状态码>)`。网络请求失败和请求发起时的取消错误继续交给调用方处理。

资源缺失使用 `404`；已有空输出或分页到末尾仍返回 `200`；实际内部故障继续返回 `500`，不会因资源读取接口而统一改为 `404`。

## SSE 实时事件

### GET /api/events

| 查询参数 | 必填 | 默认值 | 语义 |
| --- | --- | --- | --- |
| `sessionId` | 否 | 全部会话 | 非空值只过滤 `session-changed`；`ready`、`index-progress`、`sessions-changed` 仍全局推送 |

此路由没有查询参数 schema，也不验证 `sessionId` 是否存在。参数按单个字符串使用并进行 URL 编码；订阅未知会话 ID 仍能收到 `ready` 和全局事件。每条连接独立保留自己的筛选条件。

成功响应头：

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

事件是 SSE 默认消息帧，只有 `data:`，没有 `event:`、`id:` 或 `retry:` 字段。业务类型在 JSON 的 `type` 字段中，使用 `EventSource.onmessage` 或监听 `message` 接收；只监听 `session-changed` 等同名浏览器事件无法接收当前服务端帧。

```text
data: {"type":"ready","progress":{"status":"ready","discovered":1,"indexed":1,"errors":0}}

data: {"type":"index-progress","progress":{"status":"scanning","discovered":2,"indexed":1,"errors":0}}

data: {"type":"session-changed","sessionId":"session-demo","revision":"example-revision"}

data: {"type":"sessions-changed","progress":{"status":"ready","discovered":2,"indexed":2,"errors":0}}

: heartbeat

```

数据类型为 `LiveEvent`：

| `type` | 当前事件字段 | 触发与消费方式 |
| --- | --- | --- |
| `ready` | `progress: IndexProgress` | 每次连接建立后立即发送当前索引状态；重连也重新发送，前端应刷新所需列表和当前会话 |
| `index-progress` | `progress: IndexProgress` | 扫描进度、完成或索引异常；更新进度展示。扫描途中会节流，不保证每个文件一条事件 |
| `sessions-changed` | `progress: IndexProgress` | 会话集合变化、扫描结束或目录切换；重新获取列表与需要的树节点。批量变化可能合并通知 |
| `session-changed` | `sessionId: string`、可选 `revision: string` | 单个会话被重新索引或移除；使该会话详情、活动、轮次及工具相关缓存失效并按需重取。删除事件可以不带 `revision` |

SSE 是失效通知，不包含增量会话正文。它不保证每次文件写入对应一次事件，也不提供事件重放或 `Last-Event-ID` 恢复；断线后不能假设收到了全部变化，应在新的 `ready` 后重新查询。`progress.status: 'error'` 表达索引错误，不存在单独的业务 `error` 事件。

服务端每 15 秒写入 `: heartbeat` 注释，浏览器不会将其作为消息分发。连接待写缓冲超过 1 MiB 时服务端销毁该连接；客户端可依靠 `EventSource` 重连并重新读取状态。服务关闭时会结束现存 SSE 连接；前端取消订阅时调用 `close()`。

前端消费示例：

```ts
import type { LiveEvent } from '../shared/types';

const sessionId = 'session-demo';
const source = new EventSource(`/api/events?sessionId=${encodeURIComponent(sessionId)}`);

source.onmessage = (event: MessageEvent<string>) => {
  let data: LiveEvent;
  try {
    data = JSON.parse(event.data) as LiveEvent;
  } catch {
    return;
  }
  switch (data.type) {
    case 'ready':
    case 'sessions-changed':
      // 重新请求 /api/sessions，按需刷新当前会话或子树。
      break;
    case 'session-changed':
      // 按 data.sessionId 使缓存失效并重新读取；revision 可能不存在。
      break;
    case 'index-progress':
      // 用 data.progress 更新索引状态。
      break;
  }
};

source.onerror = () => {
  // 更新连接状态；EventSource 保持开启时会自动尝试重连。
};

// 页面卸载或切换订阅时执行：source.close();
```

## 维护与验证

修改路由、参数限制、共享类型、分页语义、错误处理或 SSE 时，应同步更新本文。接口行为的现有回归用例见 [api.test.ts](../tests/api.test.ts)、[client-api.test.ts](../tests/client-api.test.ts)、[parser.test.ts](../tests/parser.test.ts)、[context-api.test.ts](../tests/context-api.test.ts)、[backend-review.test.ts](../tests/backend-review.test.ts)。

在仓库根目录使用 PowerShell 7 运行相关检查：

```powershell
pnpm typecheck
pnpm exec vitest run tests/client-api.test.ts tests/api.test.ts tests/parser.test.ts tests/context-api.test.ts tests/backend-review.test.ts
```
