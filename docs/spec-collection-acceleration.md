# 技术 Spec：岗位采集提速与受控并行

| 项目 | 内容 |
| --- | --- |
| 对应 PRD | [岗位采集提速与受控并行](prd-collection-acceleration.md) |
| 状态 | 待技术评审；本阶段不实施代码改动 |
| 日期 | 2026-08-30 |
| 首发范围 | Web 多平台采集流程；不改造旧 `scrape_jobs` 兼容路径 |

## 1. 实施结论

本 Spec 定义一个可分两次发布的执行引擎：

1. P1 使用同一套写入、事件、检查点和评分流水线基础设施，但浏览器采集仍严格串行。
2. P2 仅让连续的“智联 + 51job”阶段并行，最大 2 个平台工作者、最大 3 个浏览器目标；BOSS 始终形成独占阶段。

不得通过为现有 `CollectionOrchestrator.run()` 的平台循环增加 `ThreadPoolExecutor` 来实现。并行边界必须由新的协调器管理，保证浏览器目标、SQLite 写入、风险取消和检查点都具有唯一所有者。

## 2. 范围与兼容性

### 2.1 范围

- Web 发起的多平台 `collect` 和 `full` 任务。
- 已规范化的 `_collection_options` 采集参数。
- 采集进度、`collection_runs`、自动评分、配置面板和对应测试。
- BOSS、智联、51job 的公共采集回调契约。

### 2.2 不在范围

- `src/bosshunter/scraper/jobs.py` 的旧 BOSS-only 兼容入口。它保持当前单标签、单线程行为。
- 投递、监测和回复流程。
- BOSS 内部的列表/详情并发、多个 Chrome Profile 或多个账号。
- 改变既有 BOSS 搜索页/详情页/总访问额度、随机等待和风险冷却。

### 2.3 向后兼容

1. 缺少新配置时，行为必须等价于当前安全串行模式。
2. 原有 `platform_order` 继续有效，且仍决定阶段顺序。
3. 原有进度字段 `current_platform`、各平台 `status` 和计数字段保留；新增字段只做加法。
4. 已保存的 `collection_runs.platform_states_json` 必须可读取。无 `state_version` 的历史记录视为版本 1，并按当前恢复策略处理。
5. 旧采集器测试中的 `CollectorHooks` 构造方式必须继续可用；新回调提供默认空实现或可选字段。

## 3. 配置与请求契约

### 3.1 新配置

在 `collection` 配置段新增以下值：

```yaml
collection:
  execution_mode: safe_serial       # safe_serial | pipelined | parallel_pilot
  parallel_pilot_enabled: false     # 服务端发布开关；false 时拒绝/降级 parallel_pilot
  max_non_boss_workers: 2           # 仅内部受控值，校验范围 1-2
  max_browser_targets: 3            # 仅内部受控值，校验范围 1-3
  writer_batch_size: 10             # 校验范围 1-25
  writer_flush_ms: 250              # 校验范围 50-1000
  score_batch_size: 5               # 校验范围 1-20
  score_flush_ms: 1000              # 校验范围 100-5000
  progress_flush_ms: 500            # 校验范围 250-2000
  writer_drain_timeout_seconds: 30  # 校验范围 5-60
```

默认值必须为：

```yaml
execution_mode: safe_serial
parallel_pilot_enabled: false
max_non_boss_workers: 2
max_browser_targets: 3
writer_batch_size: 10
writer_flush_ms: 250
score_batch_size: 5
score_flush_ms: 1000
progress_flush_ms: 500
writer_drain_timeout_seconds: 30
```

`parallel_pilot_enabled` 和高风险的 `parallel_boss_zhilian_enabled` 可在配置页查看和控制；岗位采集窗口选择对应模式时也会视为一次明确的用户 opt-in，并自动保存该开关。服务端仍会校验并行条件；不满足时返回实际采用的 `safe_serial` 或 `pipelined` 模式及降级原因。

### 3.2 采集请求扩展

在现有 `normalize_collection_options()` 输出上增加：

```json
{
  "execution_mode": "safe_serial",
  "platform_order": ["boss", "zhilian", "51job"],
  "auto_score": false,
  "platforms": {}
}
```

校验规则：

1. `execution_mode` 只接受 `safe_serial`、`pipelined`、`parallel_pilot`。
2. `parallel_pilot` 仅在服务端开关开启，且请求同时含 `zhilian` 和 `51job` 时保留；否则降级为 `pipelined`（当 `auto_score=true`）或 `safe_serial`。
3. 含 BOSS 的请求不能因选择 `parallel_pilot` 而与其他平台同时执行。BOSS 只构成单独阶段。
4. 配置校验不改变 `platform_order`；实际调度计划依据第 5 节从该顺序生成。

### 3.3 API 响应扩展

任务启动、任务状态和采集运行记录 API 的 `progress` 中新增下列可选字段：

```json
{
  "execution": {
    "requested_mode": "parallel_pilot",
    "effective_mode": "parallel_pilot",
    "degraded": false,
    "degradation_reason": "",
    "active_platforms": ["zhilian", "51job"],
    "active_workers": 2,
    "active_browser_targets": 3,
    "browser_target_limit": 3,
    "writer_queue_depth": 2,
    "scorer_queue_depth": 0
  }
}
```

兼容字段 `current_platform` 在只有一个活跃平台时使用该平台；多个活跃平台时设为空字符串，消费者应优先读取 `execution.active_platforms`。不得从 API 移除原字段。

## 4. 模块设计

新增模块以职责划分，而不是让编排器承担线程、数据库和浏览器资源细节。

| 模块 | 新/改 | 职责 |
| --- | --- | --- |
| `collection/execution.py` | 新 | `CollectionExecutionCoordinator`，生成阶段、启动/取消工作者、聚合结果 |
| `collection/browser_budget.py` | 新 | 可取消的浏览器目标令牌管理、标签归属和泄漏检查 |
| `collection/writer.py` | 新 | 单写入者、批量提交、成功 ID 回调、写入故障处理 |
| `collection/scoring_pipeline.py` | 新 | 接收已提交岗位 ID，以现有 `score_jobs` 执行串行批次 |
| `collection/checkpoints.py` | 新 | 平台页级检查点、状态版本转换、合并和序列化 |
| `collection/policy.py` | 新 | 共享列表预筛与详情后过滤，替代 `_SharedProcessor` 中可复用的规则 |
| `collection/orchestrator.py` | 改 | 保持公开入口和串行兼容分支；按模式委派给协调器 |
| `collection/base.py`、`models.py` | 改 | 增加可选检查点回调、候选提交结果及执行状态数据契约 |
| 各平台采集器 | 改 | 在页安全边界发检查点；通过受预算的浏览器门面开关标签 |
| `collection_run_store.py` | 改 | 写入版本化平台状态和节流后的运行记录 |
| `config.py`、schema、前端 | 改 | 默认值、校验、选择控件和可视化进度 |

## 5. 调度算法

### 5.1 阶段生成

输入为用户的 `platform_order`，输出为按序执行的阶段数组。

规则：

1. `safe_serial` 和 `pipelined`：每个平台都是一个单元素阶段。
2. `parallel_pilot`：BOSS 是硬屏障；相邻的非 BOSS 平台形成一个阶段。
3. 一个非 BOSS 阶段包含智联与 51job 两个平台时并行；只有一个时串行执行。
4. 不能为改变顺序而移动平台。

示例：

| `platform_order` | `parallel_pilot` 阶段 |
| --- | --- |
| `[boss, zhilian, 51job]` | `[boss]`，`[zhilian, 51job]` |
| `[zhilian, boss, 51job]` | `[zhilian]`，`[boss]`，`[51job]` |
| `[zhilian, 51job]` | `[zhilian, 51job]` |
| `[boss]` | `[boss]` |

每个阶段结束后必须先处理其终态，再启动下一阶段。任何 `blocked`、`browser_disconnected`、全局停止事件或写入致命错误均终止整个运行，保持当前“风险不继续切换平台”的语义。

### 5.2 协调器伪代码

```python
def run(options):
    runtime = RuntimeState.create(options)
    writer.start()
    scorer.start_if(options.auto_score and options.execution_mode != "safe_serial")
    try:
        for stage in plan_stages(options):
            if runtime.cancelled:
                break
            results = run_stage(stage, runtime)  # 1 或 2 个平台工作者
            runtime.merge(results)
            if runtime.has_terminal_blocker:
                runtime.cancel_all(runtime.stop_reason)
                break
        writer.drain_or_fail()
        scorer.drain_or_stop(runtime.cancel_event)
        return runtime.finalize()
    finally:
        runtime.cancel_all_if_needed()
        close_owned_browser_targets()
        writer.close()
        scorer.close()
        persist_terminal_state()
```

`run_stage` 使用 `ThreadPoolExecutor(max_workers=len(stage))`，但其线程只负责一个平台采集器。不得将单个平台内的“城市、关键词、页、详情”循环提交为多个 future。

### 5.3 BOSS 独占断言

协调器在启动任何 BOSS 工作者前必须断言：

```text
active_workers == 0
active_browser_targets == 0
```

若断言不成立，先取消和等待残余工作者；等待超时视为运行失败，不能启动 BOSS。BOSS 工作者继续使用当前的单 `worker_target` 复用逻辑和 `PlatformAccessGuard`。

## 6. 浏览器目标预算

### 6.1 `BrowserTargetBudget` 接口

```python
class BrowserTargetBudget:
    def acquire(self, owner: TargetOwner, stop_event: Event) -> TargetLease | None: ...
    def bind(self, lease: TargetLease, target_id: str) -> None: ...
    def release(self, target_id: str) -> None: ...
    def release_owner(self, owner: TargetOwner) -> list[str]: ...
    def snapshot(self) -> BrowserBudgetSnapshot: ...
```

`acquire` 每 100 ms 检查一次 `stop_event`，不得无限阻塞。返回 `None` 表示取消；调用方不得再调用 `new_tab`。

`TargetOwner` 固定包含 `run_id`、平台、工作者 ID 和用途（`list` 或 `detail`）。调用 `new_tab` 成功后立即 `bind`；失败或异常必须释放未绑定 lease。`close_tab` 成功与否均必须在 `finally` 中释放 lease，以免预算永久耗尽。

### 6.2 浏览器门面

为智联和 51job 构建 `BudgetedBrowser` 门面，包装现有 `new_tab`/`close_tab`：

1. `new_tab` 先取得令牌，失败时返回 `None` 并发出 `waiting_browser_slot` 进度。
2. `close_tab` 关闭浏览器后释放对应令牌。
3. 任何被协调器取消的所有者都调用 `release_owner`；它返回的 target ID 必须逐个执行关闭并记录失败。
4. 不拦截 BOSS 的内部标签复用路径；BOSS 处于独占阶段，仍须在阶段结束后验证不存在 BossHunter 所有的残余标签。

启动 P2 前应在 Browser Runtime 增加一个轻量能力测试：同一 Chrome context 中创建、导航、评估和关闭两个后台标签。失败则本次运行降级为 `pipelined`，不尝试部分并行。

## 7. 采集器与检查点契约

### 7.1 新数据模型

```python
@dataclass(frozen=True)
class SearchUnit:
    city: str
    city_code: str
    keyword: str
    page: int

@dataclass
class PlatformCheckpoint:
    version: int = 1
    completed_units: list[SearchUnit] = field(default_factory=list)
    active_unit: SearchUnit | None = None
    status: str = "queued"
    last_safe_at: str = ""

@dataclass(frozen=True)
class CandidateSubmission:
    accepted: bool
    reason: str = ""
    receipt: CandidateWriteReceipt | None = None

@dataclass
class CandidateWriteReceipt:
    unit: SearchUnit
    status: Literal["pending", "inserted", "duplicate", "save_failed"] = "pending"
    job_id: str = ""
```

`completed_units` 只记录完成的列表页，不保存详情候选全文或无限增长的来源 ID 集合。恢复时如果 `active_unit` 非空，则从该页重新开始；数据库唯一索引确保重新看到的岗位不会重复写入。

### 7.2 `CollectorHooks` 扩展

在原有字段外增加可选回调：

```python
on_checkpoint: Callable[[PlatformCheckpoint], None] | None = None
on_candidate_accepted: Callable[[JobCandidate], CandidateSubmission] | None = None
```

迁移方式：

1. 当前 `on_candidate` 保持存在，作为同步兼容回调。
2. 新协调器提供 `on_candidate_accepted`：详情后过滤通过时，将候选和当前 `SearchUnit` 推入有界写队列，并返回写入回执；队列已满时阻塞等待可取消的空位；取消时返回 `accepted=False, reason="cancelled"`。
3. 采集器优先使用 `on_candidate_accepted`，不存在时回退到 `on_candidate`，以保持旧测试桩可用。
4. 页面全部候选处理完后，采集器等待该 `SearchUnit` 的全部写入回执进入终态（`inserted`、`duplicate` 或已在详情后过滤），再发 `on_checkpoint`。写入失败或取消时保留该页为 `active_unit`，不能标记完成。

### 7.3 恢复规则

`PlatformCollectionRequest` 增加可选 `checkpoint`。采集器构造城市/关键词/页循环时跳过 `completed_units`，从 `active_unit` 的页号恢复。检查点只在以下安全边界更新：

- 开始处理列表页前：更新 `active_unit`。
- 列表页所有候选都已处理，且该页全部写入回执已进入非失败终态后：将该页加入 `completed_units`，清空 `active_unit`。
- 平台终止时：写入终态和最后一个 `active_unit`。

暂停恢复允许重新访问最后的活动页，不能重新访问已经完成的页。若记录损坏、版本不支持或搜索条件与运行记录不一致，必须拒绝恢复并提示用户创建新采集任务，不能猜测进度。

## 8. 过滤与单写入者

### 8.1 过滤职责拆分

`CandidatePolicy` 提供纯规则和显式的数据库操作边界：

| 阶段 | 规则 | 结果 |
| --- | --- | --- |
| 列表前 | 空身份、来源身份已存在、职位标题否决词、公司黑名单、平台已知基础字段不匹配 | 跳过详情并递增 `duplicate` 或 `filtered` |
| 详情后 | 搜索关键词在标题/JD 中不匹配、JD 否决词、必填字段缺失 | 不入库并递增 `filtered` 或 `parse_failed` |
| 写入时 | `INSERT OR IGNORE` 唯一来源身份写入 | 返回 `inserted` 或 `duplicate` |

列表前判断不得基于缺少 JD 的推断过滤关键词，也不得将列表快速评分失败泛化为所有平台的硬过滤。BOSS 既有 `quick_score` 行为单独保留。

### 8.2 `JobWriter` 行为

```python
class JobWriter:
    def submit(self, candidate: JobCandidate) -> CandidateSubmission: ...
    def await_unit(self, unit: SearchUnit, timeout_seconds: float) -> UnitWriteResult: ...
    def start(self) -> None: ...
    def drain(self, timeout_seconds: float) -> bool: ...
    def stop(self, discard_pending: bool = False) -> None: ...
```

实现要求：

1. 只有 writer 线程持有写数据库连接；连接由 `get_db(db_path)` 在该线程创建和关闭。
2. 队列 `maxsize=50`。采集器等待入队时每 100 ms 检查全局取消事件；每个已接受候选关联一个只完成一次的写入回执。
3. 每批最多 `writer_batch_size` 条，或等待 `writer_flush_ms` 后提交；单批使用一个 SQLite 事务。
4. 使用与当前 `insert_job_if_new` 完全等价的字段映射和唯一索引语义。为支持单事务，应新增不自行 `commit()` 的私有插入函数；公共兼容函数保持不变。
5. 每条候选产生一个终态：`inserted`、`duplicate`、`filtered`、`save_failed`。批次发生异常时，回滚全批并逐条有限重试一次；第二次仍失败时标记 `save_failed` 并触发协调器的致命错误。
6. Writer 按 `SearchUnit` 汇总回执；采集器在页面结束时通过 `await_unit` 确认所有候选已持久化或已判重，才允许持久化该页检查点。
7. 只有 `inserted` 的岗位 ID 会被追加到 `collected_job_ids` 和自动评分队列。
8. 任务结束、用户停止和用户暂停时均必须先按 `writer_drain_timeout_seconds` 排空已接受队列。超时或队列未清空时保留活动页检查点、报告未完成数，且不得把该页标为完成。

现有 `_SharedProcessor` 不应在多个线程共享。其计数、过滤和保存逻辑拆入 `CandidatePolicy`、`JobWriter` 与协调器的线程安全 `RuntimeState`；串行分支可继续通过适配器调用同一规则。

## 9. 自动评分流水线

### 9.1 启动条件

仅当 `auto_score=true` 且有效模式为 `pipelined` 或 `parallel_pilot` 时启动。安全串行保持现有“采集后统一评分”行为，降低兼容风险。

### 9.2 执行方式

1. Writer 每次提交 `inserted` 岗位 ID 后调用 `ScoringPipeline.submit(job_id)`。
2. Pipeline 去重 ID，以 `score_batch_size` 或 `score_flush_ms` 形成批次。
3. 一个 pipeline 同时只调用一次现有 `score_jobs(scope="selected", job_ids=batch, force_rescore=False)`；函数内部继续使用现有 `ai.scoring_concurrency`。
4. 评分批次的数据库写入沿用评分模块自身连接和事务，不能复用 `JobWriter` 的连接。
5. 全局取消时不再启动新批次；已启动的评分通过同一个 stop event 协作结束。采集任务不得因评分单批失败而丢失已入库岗位，但整体结果应为 `completed_with_errors`。

评分进度采用 `score_completed`、`score_passed`、`score_filtered`、`score_failed` 计数，并与采集计数分开，防止前端把未评分误解为采集失败。

## 10. 运行记录与状态机

### 10.1 `platform_states_json` 版本 2

不需要增加 SQLite 表或列。现有 JSON 字段按下列形状持久化：

```json
{
  "state_version": 2,
  "execution": {
    "requested_mode": "parallel_pilot",
    "effective_mode": "parallel_pilot",
    "degraded": false,
    "degradation_reason": ""
  },
  "platforms": {
    "zhilian": {
      "status": "running",
      "metrics": {"seen": 20, "new": 4, "duplicate": 2, "filtered": 3, "parse_failed": 0, "save_failed": 0},
      "checkpoint": {"version": 1, "completed_units": [], "active_unit": {}, "status": "running", "last_safe_at": ""},
      "reason_code": "",
      "message": ""
    }
  },
  "writer": {"queue_depth": 0, "pending_count": 0},
  "scorer": {"status": "running", "queue_depth": 0}
}
```

`collection_runs.current_platform` 保留并只在单平台阶段填写，用于历史 API 兼容。新代码不以它决定恢复目标。

### 10.2 状态转换

```text
queued -> waiting_stage -> waiting_browser_slot -> running -> draining -> completed
                                      |                |          |
                                      +-> stopped      +-> blocked/failed

task: running -> pausing -> paused -> running
task: running -> stopping -> stopped
task: running -> completed | completed_with_shortage | completed_with_errors
```

- `draining` 表示采集器已退出、writer 或 scorer 仍有待完成工作；此时不得启动下一个平台阶段。
- `blocked` 是终态，必须携带平台与原始 `reason_code`。
- `paused` 只在所有采集工作者已退出、当前写入批次已提交或明确失败、检查点已持久化后出现。

### 10.3 持久化节流

协调器将事件合并到内存 `RuntimeState`，以 `progress_flush_ms` 至多每 500 ms 写一次运行记录；以下情况立即写入：阶段开始、检查点更新、风险/阻断、取消、降级、writer 致命错误和终态。持久化本身失败即停止新工作并标记 `completed_with_errors`。

## 11. 停止、风险与降级

| 事件 | 采集器行为 | Writer/Scorer 行为 | 运行结果 |
| --- | --- | --- | --- |
| 用户停止 | 禁止新工作，关闭自有标签，安全点退出 | Writer 排空已接受队列；Scorer 停止新批次 | `stopped` |
| 用户暂停 | 同停止，但保留检查点 | Writer 排空已接受队列；Scorer 停止新批次 | `paused` |
| BOSS 风险 | 设置全局取消，停止所有平台 | Writer 排空已接受队列，保留已提交数据 | `stopped` 或 `completed_with_errors`，并写风险原因 |
| 智联/51job 阻断（试点） | 取消同阶段伙伴和后续阶段 | Writer 排空已接受队列；Scorer 停止新批次 | 本轮停止，记录 `degraded=true` |
| 浏览器能力测试失败 | 不启动并行工作者 | 正常 | 开始前降级为 `pipelined`/`safe_serial` |
| 写入者致命错误 | 停止新候选提交并取消工作者 | 回滚当前批次，报告数量 | `completed_with_errors` |
| 评分批次失败 | 继续保存和采集 | 记录失败并停止后续评分批次 | `completed_with_errors` |

自动降级只影响本轮的 `effective_mode`。是否让下次任务默认安全串行，应在配置中写入一个短期降级标记，默认有效期 24 小时；用户仍可手动重新选择，但 UI 必须展示上次降级原因。该标记不改变原始 `execution_mode` 偏好。

## 12. 前端实现要求

1. 在现有采集弹窗中增加一个紧凑的速度模式选择控件，默认安全串行。
2. `parallel_pilot` 不可用时显示禁用状态和服务端给出的原因，不由前端猜测开关状态。
3. 任务进度区域使用每平台行展示并发状态；同一时间可有两行 `running` 或 `waiting_browser_slot`。
4. 展示模式、活跃平台数、浏览器目标使用量、写入/评分队列和降级原因；不展示内部线程名、target ID 或风控证据原文。
5. 对旧后端响应或历史任务，隐藏新增数据并沿用单 `current_platform` 展示。
6. 前端轮询频率保持现状；不能为显示并行状态提高轮询频率。

## 13. 实施顺序

### P0：观测与契约准备

1. 为现有串行流程补充列表加载、详情加载、等待、写入、评分阶段耗时和终态原因统计。
2. 扩展请求/响应为加法字段，但默认仍为 `safe_serial`。
3. 编写 `RuntimeState`、版本化运行记录读写和兼容测试。

### P1：无浏览器并行的流水线

1. 实现 `CandidatePolicy` 与 `JobWriter`，保持安全串行平台调度。
2. 实现页面级检查点和进度节流。
3. 实现 `ScoringPipeline`，仅在 `pipelined` 且 `auto_score=true` 时使用。
4. 为所有平台接入保守列表预筛；BOSS 既有快速评分逻辑不变。
5. 对照当前安全串行输出做回归测试后，灰度 `pipelined`。

### P2：跨平台试点

1. 实现 `BrowserTargetBudget`、预算浏览器门面和 Chrome 多标签能力测试。
2. 实现阶段生成器与最多两平台工作者；仅开放智联 + 51job 的连续阶段。
3. 实现全局取消、自动降级、每平台恢复与 UI 状态。
4. 使用发布开关灰度，先只允许内部/受控用户，再逐步扩大。

不允许将 P1 与 P2 合并为一次大改动；P1 的保存、进度和恢复稳定性是 P2 的前置条件。

## 14. 测试清单

| 层级 | 场景 | 断言 |
| --- | --- | --- |
| 单元 | 阶段生成 | BOSS 为屏障；只并行连续的智联+51job；顺序不变 |
| 单元 | 目标预算 | 不超过 3；取消可唤醒等待者；异常不会泄漏令牌 |
| 单元 | Writer | 同一来源重复提交只新增一次；批次失败回滚；重试后正确计数 |
| 单元 | Policy | 列表前规则保守；JD 关键词匹配只在详情后执行 |
| 单元 | Checkpoint | 活动页重试、完成页跳过、历史版本读取、条件不匹配拒绝恢复 |
| 单元 | Pipeline | 只消费 inserted ID；批次去重；停止后不启动新批次 |
| 集成 | 串行回归 | 三平台顺序、计数、风险停止与现有测试预期一致 |
| 集成 | 并行交错 | 智联/51job 同时产生候选，结果唯一、进度独立、writer 单线程提交 |
| 集成 | 阻断 | 任一试点平台阻断后伙伴停止、标签清理、记录降级原因 |
| 集成 | BOSS 风险 | BOSS 前后不与其他平台重叠；风险后不启动后续阶段 |
| 集成 | 暂停恢复 | 页级检查点正确；允许重访活动页但数据库无重复岗位 |
| 端到端 | Chrome 能力探测 | 两后台标签成功才允许试点；失败自动降级 |

新增测试应优先放在 `tests/test_collection_orchestrator.py`、`tests/test_collection_runs.py`、`tests/test_scraper_background.py`，并针对新模块新增独立测试文件。所有既有安全测试必须保持通过。

## 15. 发布、回滚与验收门槛

1. 首先合入 P0/P1，默认 `safe_serial`，通过配置或受控用户开启 `pipelined`。
2. P1 满足 PRD 中时长、风险和保存可靠性目标后，才合入/开启 P2。
3. P2 初始仅使用 `parallel_pilot_enabled=true` 的受控环境，灰度比例从 0% 开始；任何 P1 级数据完整性事故立即关闭开关。
4. 回滚仅需关闭 `parallel_pilot_enabled` 或把有效模式降为 `safe_serial`；已写入的状态版本 2 仍必须可读。
5. 发布后连续 7 天监控每平台详情成功率、风险事件率、写入失败率、取消时延、目标泄漏次数和总时长分位数。

## 16. 评审待决项

1. `writer_batch_size=10`、`writer_flush_ms=250` 与目标令牌上限 3 是否需要先用 P0 真实数据校准。
2. 评分流水线是否允许安全串行模式启用；本 Spec 为降低首发风险暂不允许。
3. 评分批次失败是否只记录 `completed_with_errors`，还是需要提供独立“重试本轮评分”入口。
4. 24 小时自动降级标记的存储位置应使用配置文件还是 SQLite 状态表；建议使用 SQLite，避免修改用户的长期配置偏好。
5. 浏览器 Runtime 的双标签能力探测是否需要持久化结果；建议只作为每次试点任务开始前的即时检查。
