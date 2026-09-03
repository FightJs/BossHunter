import { useEffect, useMemo, useState } from 'react'
import { useDashboard, type CollectionProgress, type GreetingProgress, type GreetingRun, type HistoryItem, type Job, type ScoringProgress, type ScoringRun, type SendProgress, type WorkbenchTask } from '@/hooks/useDashboard'
import { useJobSearch, type JobSortKey, type JobSortOrder } from '@/hooks/useJobSearch'
import { Button } from '@/components/ui/button'
import { JobsTable } from '@/components/dashboard/JobsTable'
import { RecycleBinPanel } from '@/components/dashboard/RecycleBinPanel'
import { ScoreJobsDialog } from '@/components/dashboard/ScoreJobsDialog'
import { CollectJobsDialog } from '@/components/dashboard/CollectJobsDialog'
import { TaskCompletionDialog } from '@/components/dashboard/TaskCompletionDialog'
import { JobFilterBar } from '@/components/jobs/JobFilterBar'
import { parseHistoryDetail } from '@/lib/historyDetail'
import {
  EMPTY_JOB_FILTERS,
  filterJobs,
  hasInvalidSalaryRange,
  useDebouncedValue,
  type JobFilters,
} from '@/lib/jobFilters'
import { getActionLabel, getStatusLabel } from '@/lib/status'
import { cn } from '@/lib/utils'
import {
  AlertTriangle,
  BriefcaseBusiness,
  Download,
  ExternalLink,
  Eye,
  MessageCircle,
  Pause,
  Play,
  RefreshCw,
  Send,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react'

type WorkbenchMode = 'full' | 'collect' | 'score' | 'greet' | 'rescore' | 'monitor'
type DashboardView = 'workbench' | 'jobs' | 'monitor'
type StatsScope = 'today' | 'total'

const TASK_STAGE_LABELS = [
  '开始采集岗位',
  '开始 AI 评分',
  '开始重新评分',
  '开始生成招呼语',
  '招呼语生成完成',
  'AI 评分进度',
  '等待前端确认投递',
  '发送失败待处理',
  '执行一轮监测',
  '本轮监测完成，30 分钟后再次检查',
]

function currentTaskStage(logs: string[] = []) {
  for (const log of logs.slice().reverse()) {
    if (log.includes('AI 评分进度')) return log
    if (log.includes('招呼语发送结果')) return log
    if (log.includes('发送招呼语')) return '发送招呼语'
    if (log.includes('生成招呼语')) return '生成招呼语'
    const stage = TASK_STAGE_LABELS.find(label => log.includes(label))
    if (stage) return stage
  }
  return '等待后端返回阶段'
}

function taskStatusText(status: string) {
  if (status === 'failed') return '运行失败'
  if (status === 'completed') return '已结束'
  if (status === 'stopped') return '已停止'
  if (status === 'stopping') return '停止中'
  if (status === 'pausing') return '暂停中'
  if (status === 'paused') return '已暂停，可继续'
  return '运行中'
}

function taskStatusClass(status: string) {
  if (status === 'failed') return 'border-red-100 bg-red-50'
  if (status === 'completed' || status === 'stopped') return 'border-card-border bg-white'
  return 'border-primary/20 bg-[#FFF0E5]'
}

function taskStatusTitle(status: string) {
  if (status === 'completed' || status === 'stopped') return '最近任务状态'
  return '当前阶段'
}

function taskStopReasonLabel(reason?: string) {
  if (reason === 'daily_limit') return '今日发送额度已用完，岗位已保留在“待发送招呼语”；明日额度恢复后再重试。'
  if (reason === 'outside_window') return '当前不在发送时间窗口内，岗位已保留在“待发送招呼语”。'
  if (reason === 'day_off') return '今日触发防检测休息策略，岗位已保留在“待发送招呼语”。'
  if (reason === 'stopped') return '任务已按你的要求停止，尚未处理的岗位仍保留在队列中。'
  return reason
}

function checkpointLabel(stage?: string) {
  const labels: Record<string, string> = {
    collect: '岗位采集',
    collect_complete: '采集完成',
    rescore: '重新评分',
    score: 'AI 评分',
    waiting_confirmation: '等待确认投递',
    deliver: '准备投递',
    greeting: '生成招呼语',
    send: '发送招呼语',
    monitor: '监测回复',
  }
  return labels[stage || ''] || stage || ''
}

function taskErrorFeedback(error: string) {
  const normalized = error.toLowerCase()
  if (
    normalized.includes('api key')
    || normalized.includes('authentication')
    || normalized.includes('unauthorized')
    || normalized.includes('401')
    || normalized.includes('403')
  ) {
    return {
      title: 'AI 接口认证失败',
      detail: '请到“配置 → AI 设置”检查 API Key、Base URL 和模型名称，保存后点击“测试连接”。',
    }
  }
  if (
    normalized.includes('chrome')
    || normalized.includes('cdp')
    || normalized.includes('websocket')
    || normalized.includes('browser runtime')
    || normalized.includes('not connected')
  ) {
    return {
      title: 'Google Chrome 连接中断',
      detail: '请确认 Google Chrome 正在运行且已开启远程调试，再点击上方“重新检查”。',
    }
  }
  if (normalized.includes('zhipin') || normalized.includes('登录') || normalized.includes('login')) {
    return {
      title: '招聘平台页面或登录状态异常',
      detail: '请在已连接的 Google Chrome 中打开 BOSS 直聘并确认账号仍处于登录状态。',
    }
  }
  return {
    title: '任务运行失败',
    detail: '请查看原始错误；修复配置或连接问题后，重新运行启动检查。',
  }
}

interface DashboardPageProps {
  view?: DashboardView
}

interface PreflightCheck {
  id: string
  title: string
  status: 'pass' | 'warning' | 'error'
  message: string
  detail: string
  action?: 'config' | 'browser' | ''
}

const modes: Array<{ mode: WorkbenchMode; title: string; description: string }> = [
  {
    mode: 'full',
    title: '运行全流程',
    description: '采集 → AI评分 → 确认投递 → 打招呼 → 持续监测，一次跑完整流程。',
  },
  {
    mode: 'collect',
    title: '单独采集',
    description: '打开岗位采集窗口，选择 BOSS/智联/51job、最大页数、排序和执行顺序；默认只采集不评分。',
  },
  {
    mode: 'score',
    title: '单独 AI 评分',
    description: '只处理岗位池中的未评分岗位；可与岗位采集并行，不打开招聘网站，也不会投递。',
  },
  {
    mode: 'greet',
    title: '单独生成招呼语',
    description: '为今日待确认岗位批量生成招呼语；只写入岗位池，不发送消息，可与采集和评分分开运行。',
  },
  {
    mode: 'monitor',
    title: '单独监测',
    description: '只监测过往已投递项目；发现 HR 要简历或问题后进入对应处理。',
  },
]

const MODE_RESOURCE_FALLBACK: Record<string, string[]> = {
  full: ['pipeline', 'browser', 'collection', 'scoring', 'greeting', 'delivery', 'monitor'],
  collect: ['browser', 'collection'],
  score: ['scoring'],
  rescore: ['scoring'],
  greet: ['greeting'],
  monitor: ['browser', 'monitor'],
  deliver: ['browser', 'delivery', 'greeting'],
}

function taskResources(task: WorkbenchTask) {
  return new Set(task.resources?.length ? task.resources : MODE_RESOURCE_FALLBACK[task.mode] || [])
}

function modesConflict(mode: WorkbenchMode, task: WorkbenchTask) {
  if (mode === 'full' || task.mode === 'full') return true
  const requested = new Set(MODE_RESOURCE_FALLBACK[mode] || [])
  const occupied = taskResources(task)
  return [...requested].some(resource => occupied.has(resource))
}

const COMPLETION_MODES = new Set<WorkbenchTask['mode']>(['collect', 'score', 'rescore', 'greet', 'deliver'])
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'stopped'])

function taskSnapshot(value: unknown): WorkbenchTask | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<WorkbenchTask>
  return typeof candidate.id === 'string' && typeof candidate.mode === 'string'
    ? value as WorkbenchTask
    : null
}

const statItems = [
  { key: '采集总数', todayLabel: '今日新增岗位', totalLabel: '累计采集岗位' },
  { key: '初筛通过', todayLabel: '今日初筛通过', totalLabel: '累计初筛通过', highlight: true },
  { key: 'AI评分', todayLabel: '今日 AI 评分', totalLabel: '累计 AI 评分' },
  { key: 'pending', todayLabel: '当前待确认', totalLabel: '当前待确认', highlight: true, current: true },
  { key: '发送', todayLabel: '今日已投递', totalLabel: '累计已投递', highlight: true },
]

const taskMetricItems = [
  { key: 'collect_seen', label: '本轮扫描' },
  { key: 'collect_new', label: '本轮新增' },
  { key: 'collect_duplicate', label: '重复岗位' },
  { key: 'collect_filtered', label: '过滤' },
  { key: 'collect_parse_failed', label: '解析失败' },
  { key: 'collect_save_failed', label: '保存失败' },
  { key: 'ai_passed', label: 'AI通过' },
  { key: 'ai_filtered', label: 'AI过滤' },
  { key: 'ai_failed', label: 'AI失败' },
  { key: 'greeting_completed', label: '招呼语已处理' },
  { key: 'greeting_total', label: '招呼语总数' },
  { key: 'greeting_generated', label: '招呼语已生成' },
  { key: 'greeting_failed', label: '招呼语失败' },
  { key: 'send_success', label: '发送成功' },
  { key: 'send_deferred', label: '待下次发送' },
  { key: 'send_remaining_quota', label: '今日剩余额度' },
]

function jobSubtitle(job: Job) {
  return [job.score ? `匹配 ${job.score}` : '', job.salary, job.hr_active || '活跃度未知', getStatusLabel(job.status)].filter(Boolean).join(' · ')
}

async function parsePreflightResponse(res: Response) {
  const rawText = await res.text()
  let data: { ok?: boolean; messages?: unknown; checks?: unknown; error?: string } = {}
  try {
    data = rawText ? JSON.parse(rawText) : {}
  } catch {
    const message = `无法解析预检响应：预检接口返回 ${res.status}`
    return {
      ok: false,
      messages: [message],
      checks: [{ id: 'preflight_api', title: '启动检查', status: 'error', message, detail: '请重启 BossHunter 后重试。' }] as PreflightCheck[],
    }
  }
  const messages = Array.isArray(data.messages) ? data.messages.map(String).filter(Boolean) : []
  const checks = Array.isArray(data.checks)
    ? data.checks.filter((item): item is PreflightCheck => Boolean(
      item
      && typeof item === 'object'
      && 'id' in item
      && 'status' in item
      && 'message' in item
    ))
    : []
  if (data.error) messages.push(String(data.error))
  if (!res.ok) messages.push(`预检接口返回 ${res.status}`)
  if (!data.ok && messages.length === 0) messages.push('后端未返回具体原因')
  if (checks.length === 0 && messages.length > 0) {
    checks.push(...messages.map((message, index) => ({
      id: `legacy-${index}`,
      title: '启动检查',
      status: 'error' as const,
      message,
      detail: '请按提示修复后重新检测。',
    })))
  }
  return { ok: Boolean(res.ok && data.ok), messages, checks }
}

function PreflightPanel({
  checks,
  checking,
  onRetry,
}: {
  checks: PreflightCheck[]
  checking: boolean
  onRetry: () => void
}) {
  const actionableChecks = checks.filter(check => check.status !== 'pass')
  if (actionableChecks.length === 0) return null

  const errors = actionableChecks.filter(check => check.status === 'error').length
  const warnings = actionableChecks.filter(check => check.status === 'warning').length
  const needsConfig = actionableChecks.some(check => check.action === 'config')
  const heading = errors ? `启动检查发现 ${errors} 个问题` : `启动检查有 ${warnings} 项提醒`

  return (
    <div className={`mt-3 rounded-3xl border p-4 ${
      errors ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'
    }`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {errors
            ? <XCircle className="h-5 w-5 text-danger" />
            : <AlertTriangle className="h-5 w-5 text-amber-600" />}
          <div className="text-sm font-black text-foreground">{heading}</div>
        </div>
        <div className="flex items-center gap-2">
          {needsConfig && (
            <Button variant="secondary" size="sm" onClick={() => window.location.assign('/config')}>
              打开配置
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={onRetry} disabled={checking}>
            <RefreshCw className={`mr-2 h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
            {checking ? '检查中' : '重新检查'}
          </Button>
        </div>
      </div>
      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        {actionableChecks.map(check => {
          const isError = check.status === 'error'
          return (
            <div
              key={`${check.id}-${check.title}`}
              className={`rounded-2xl border bg-white px-3 py-3 ${isError ? 'border-red-200' : 'border-amber-200'}`}
            >
              <div className="flex items-start gap-2">
                {isError
                  ? <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                  : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />}
                <div>
                  <div className="text-xs font-black text-muted">{check.title}</div>
                  <div className="mt-0.5 text-sm font-black text-foreground">{check.message}</div>
                  <p className="mt-1 text-xs leading-5 text-muted">{check.detail}</p>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function DashboardPage({ view = 'workbench' }: DashboardPageProps) {
  const {
    workbench,
    history,
    loading,
    error,
    refreshing,
    lastRefreshedAt,
    refresh,
    startTask,
    stopTask,
    pauseTask,
    resumeTask,
    retryTask,
  } = useDashboard(view)
  const [selected, setSelected] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [preflightChecks, setPreflightChecks] = useState<PreflightCheck[]>([])
  const [preflightMode, setPreflightMode] = useState<WorkbenchMode>('full')
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [modePending, setModePending] = useState<WorkbenchMode | null>(null)
  const [confirmedDeliveryIds, setConfirmedDeliveryIds] = useState<Set<string>>(new Set())
  const [todayFilters, setTodayFilters] = useState<JobFilters>({ ...EMPTY_JOB_FILTERS })
  const [statsScope, setStatsScope] = useState<StatsScope>('today')
  const [collectDialogOpen, setCollectDialogOpen] = useState(false)
  const [collectDialogMode, setCollectDialogMode] = useState<'collect' | 'full'>('collect')
  const [resumingTaskId, setResumingTaskId] = useState<string | null>(null)
  // Keep terminal results visible until the user explicitly acknowledges them.
  // Task snapshots are retained by the backend, but only tasks started from this
  // page are surfaced as a completion prompt so old history does not interrupt a
  // fresh session.
  const [completionTaskIds, setCompletionTaskIds] = useState<string[]>([])

  const todayJobs = useMemo(
    () => (workbench.today_pending_confirmation || workbench.pending_confirmation)
      .filter(job => !confirmedDeliveryIds.has(job.id)),
    [workbench.today_pending_confirmation, workbench.pending_confirmation, confirmedDeliveryIds]
  )
  const debouncedTodayQuery = useDebouncedValue(todayFilters.query, 250)
  const effectiveTodayFilters = useMemo(
    () => ({ ...todayFilters, query: debouncedTodayQuery }),
    [todayFilters, debouncedTodayQuery]
  )
  const filteredTodayJobs = useMemo(
    () => filterJobs(todayJobs, effectiveTodayFilters),
    [todayJobs, effectiveTodayFilters]
  )
  const visibleJobIds = useMemo(() => new Set(filteredTodayJobs.map(job => job.id)), [filteredTodayJobs])
  const actionableSelected = useMemo(() => selected.filter(id => visibleJobIds.has(id)), [selected, visibleJobIds])

  useEffect(() => {
    setSelected(previous => {
      const next = previous.filter(id => visibleJobIds.has(id))
      return next.length === previous.length ? previous : next
    })
  }, [visibleJobIds])

  useEffect(() => {
    const handleConfigSaved = () => { void refresh() }
    window.addEventListener('bosshunter-config-saved', handleConfigSaved)
    return () => window.removeEventListener('bosshunter-config-saved', handleConfigSaved)
  }, [refresh])

  const pendingGreetingJobs = workbench.pending_greetings
  const activeTasks = (workbench.active_tasks && workbench.active_tasks.length > 0)
    ? workbench.active_tasks.filter(task => ['running', 'stopping', 'pausing'].includes(task.status))
    : (workbench.task && ['running', 'stopping', 'pausing'].includes(workbench.task.status) ? [workbench.task] : [])
  const pausedTasks = workbench.paused_tasks || []
  const activeTask = activeTasks[0] || null
  const visibleTask = activeTask || workbench.last_task
  const pausedTask = !activeTask && visibleTask?.status === 'paused' ? visibleTask : null
  const visibleTaskError = visibleTask?.error ? taskErrorFeedback(visibleTask.error) : null
  const durableScoringRuns = workbench.scoring_runs || []
  const durableGreetingRuns = workbench.greeting_runs || []
  const activeGreetingTask = activeTasks.find(task => task.mode === 'greet')
    || pausedTasks.find(task => task.mode === 'greet')
    || null
  const pendingReplies = history.filter(item => item.action === 'reply_pending')
  const hasAdditionalPausedTasks = pausedTasks.some(task => task.id !== visibleTask?.id)

  const taskSnapshots = useMemo(() => {
    const byId = new Map<string, WorkbenchTask>()
    for (const task of [
      ...(workbench.tasks || []),
      ...(workbench.active_tasks || []),
      ...(workbench.paused_tasks || []),
      workbench.task,
      workbench.last_task,
    ]) {
      if (task) byId.set(task.id, task)
    }
    return byId
  }, [workbench.tasks, workbench.active_tasks, workbench.paused_tasks, workbench.task, workbench.last_task])

  const completionTask = useMemo(
    () => completionTaskIds
      .map(id => taskSnapshots.get(id))
      .find(task => Boolean(task && COMPLETION_MODES.has(task.mode) && TERMINAL_TASK_STATUSES.has(task.status))) || null,
    [completionTaskIds, taskSnapshots],
  )

  const trackCompletionTask = (task: WorkbenchTask | null | undefined) => {
    if (!task || !COMPLETION_MODES.has(task.mode)) return
    setCompletionTaskIds(previous => previous.includes(task.id) ? previous : [...previous, task.id])
  }

  const acknowledgeCompletion = () => {
    if (!completionTask) return
    setCompletionTaskIds(previous => previous.filter(id => id !== completionTask.id))
  }

  const retryCompletion = (task: WorkbenchTask) => {
    setCompletionTaskIds(previous => previous.filter(id => id !== task.id))
    void retryTask(task.id).then(() => setNotice('已重新尝试任务。')).catch(err => setNotice(err instanceof Error ? err.message : '重试失败'))
  }

  const toggleJob = (id: string) => {
    setSelected(prev => (prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]))
  }

  const actOnScoringRun = async (run: ScoringRun, action: 'pause' | 'resume' | 'end') => {
    try {
      const res = await fetch(`/api/scoring/runs/${run.id}/${action}`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '评分任务操作失败')
      trackCompletionTask(taskSnapshot(data.task))
      await refresh()
      setNotice(action === 'end' ? '已结束评分任务，岗位池现在可以清空。' : action === 'pause' ? '已请求暂停评分，当前完成结果会保留。' : '已从断点继续评分。')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '评分任务操作失败')
    }
  }

  const actOnGreetingRun = async (run: GreetingRun, action: 'pause' | 'resume' | 'end') => {
    try {
      const res = await fetch(`/api/greeting/runs/${run.id}/${action}`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '招呼语任务操作失败')
      trackCompletionTask(taskSnapshot(data.task))
      await refresh()
      setNotice(action === 'resume' ? '已从招呼语断点继续。' : action === 'pause' ? '已请求暂停，已生成内容会保留。' : '已结束招呼语生成任务。')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '招呼语任务操作失败')
    }
  }

  const startTodayGreetings = async () => {
    const jobIds = todayJobs.map(job => job.id)
    if (!jobIds.length) {
      setNotice('今天暂时没有待确认岗位可生成招呼语。')
      return
    }
    if (!window.confirm(`将为今日待确认中的 ${jobIds.length} 个岗位生成招呼语，不会立即发送，是否继续？`)) return
    setModePending('greet')
    setNotice('单独生成招呼语启动前预检中...')
    try {
      if (!(await runPreflight('greet', { scope: 'today_pending', job_ids: jobIds }))) return
      const task = await startTask('greet', { scope: 'today_pending', job_ids: jobIds })
      trackCompletionTask(task)
      setNotice(`已启动今日待确认岗位的招呼语生成，共 ${jobIds.length} 个岗位；完成后可单独投递。`)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '启动招呼语生成失败')
    } finally {
      setModePending(null)
    }
  }

  const runPreflight = async (mode: WorkbenchMode, options?: Record<string, unknown>) => {
    setPreflightMode(mode)
    const res = options
      ? await fetch('/api/workbench/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, options }),
      })
      : await fetch(`/api/workbench/preflight?mode=${mode}`)
    const data = await parsePreflightResponse(res)
    setPreflightChecks(data.checks)
    if (!data.ok) {
      setNotice('请按提示处理后再启动')
      return false
    }
    return true
  }

  const handleModeClick = async (mode: WorkbenchMode) => {
    try {
      const sameModeTask = activeTasks.find(task => task.mode === mode)
      let taskToStop = sameModeTask
      if (activeTask?.mode === mode) taskToStop = activeTask
      if (taskToStop) {
        if (window.confirm(`是否停止当前${taskToStop.label}任务？已入库岗位会保留。`)) {
          setModePending(mode)
          setNotice(`正在停止${taskToStop.label}...`)
          const task = await stopTask(taskToStop.id)
          trackCompletionTask(task)
          setNotice(`${taskToStop.label}已请求停止。`)
        }
        return
      }
      if (modePending) return
      const conflictingTask = activeTasks.find(task => modesConflict(mode, task))
      if (conflictingTask) {
        setNotice(
          conflictingTask.status === 'stopping'
            ? `当前${conflictingTask.label}正在停止，请等待后台完全结束后再启动冲突模式。`
            : `当前${conflictingTask.label}占用相同运行资源；可同时运行 AI 评分、招呼语生成等独立任务。`
        )
        return
      }
      if (mode === 'full') {
        setCollectDialogMode('full')
        setCollectDialogOpen(true)
        return
      }
      if (mode === 'greet') {
        await startTodayGreetings()
        return
      }
      const target = modes.find(item => item.mode === mode)
      setModePending(mode)
      setNotice(`${target?.title || '任务'}启动前预检中...`)
      if (!(await runPreflight(mode))) return
      setNotice(`${target?.title || '任务'}启动中，请稍候...`)
      const task = await startTask(mode)
      trackCompletionTask(task)
      setNotice(`${target?.title || '任务'}已启动，日志会在下方更新。`)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '操作失败')
    } finally {
      setModePending(null)
    }
  }

  const retryPreflight = async () => {
    if (modePending) return
    try {
      setModePending(preflightMode)
      setNotice('正在重新检查运行环境...')
      const ok = await runPreflight(preflightMode)
      setNotice(ok ? '' : '仍有问题需要处理，请查看检查结果。')
    } catch {
      setNotice('重新检查失败，请确认 BossHunter 后端仍在运行。')
    } finally {
      setModePending(null)
    }
  }

  const startCollection = async (options: Record<string, unknown>) => {
    const mode = collectDialogMode
    setModePending(mode)
    setNotice(mode === 'full' ? '全流程启动前预检中...' : mode === 'collect' ? '岗位采集启动前预检中...' : `${modes.find(item => item.mode === mode)?.title || '任务'}启动前预检中...`)
    try {
      if (!(await runPreflight(mode, options))) return
      if (resumingTaskId) {
        const task = await resumeTask(resumingTaskId, options)
        trackCompletionTask(task)
        setResumingTaskId(null)
      } else {
        const task = await startTask(mode, options)
        trackCompletionTask(task)
      }
      // Keep the completion prompt independent from the setup dialog. The
      // setup closes after launch, and the result remains until confirmation.
      setCollectDialogOpen(false)
      setNotice(resumingTaskId ? '已按新的设置从断点继续执行。' : mode === 'full' ? '全流程已启动，进度会在下方更新。' : mode === 'collect' ? '岗位采集已启动，进度会在下方更新。' : `${modes.find(item => item.mode === mode)?.title || '任务'}已启动，进度会在下方更新。`)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '岗位采集启动失败')
    } finally {
      setModePending(null)
    }
  }

  const confirmDeliver = async (ids: string[]) => {
    if (!ids.length) return
    const count = ids.length
    if (!window.confirm(`是否投递以下 ${count} 个岗位？确认后将进入投递/打招呼流程。`)) return
    try {
      const res = await fetch('/api/workbench/deliver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_ids: ids }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || '投递失败')
      }
      const data = await res.json().catch(() => ({}))
      trackCompletionTask(taskSnapshot(data))
      if (!ids.some(id => workbench.send_errors.some(job => job.id === id))) {
        setConfirmedDeliveryIds(prev => new Set([...prev, ...ids]))
      }
      await refresh()
      setNotice(
        data.already_queued_count === count
          ? `所选 ${count} 个岗位已在当前发送队列中。`
          : data.queued_count
            ? `已将 ${data.queued_count} 个岗位追加到当前发送队列。`
            : `已确认投递 ${count} 个岗位，后端会按队列推进。`
      )
      setSelected(prev => prev.filter(id => !new Set(ids).has(id)))
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '投递失败')
    }
  }

  const rejectSelectedJobs = async (ids: string[]) => {
    if (!ids.length) return
    const count = ids.length
    if (!window.confirm(`确定放弃这 ${count} 个岗位吗？放弃后不会进入投递，可在岗位池中查看已拒绝状态。`)) return
    try {
      const res = await fetch('/api/workbench/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_ids: ids }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || '放弃失败')
      }
      const rejectedIds = new Set(ids)
      setSelected(prev => prev.filter(id => !rejectedIds.has(id)))
      setConfirmedDeliveryIds(prev => new Set([...prev, ...ids]))
      await refresh()
      setNotice(`已放弃 ${count} 个岗位。`)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '放弃失败')
    }
  }

  const sendReadyGreetings = async (ids: string[]) => {
    if (!ids.length) return
    const count = ids.length
    try {
      const res = await fetch('/api/workbench/deliver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_ids: ids, direct_send: true }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || '发送失败')
      }
      const data = await res.json().catch(() => ({}))
      trackCompletionTask(taskSnapshot(data))
      await refresh()
      setNotice(
        data.already_queued_count === count
          ? `所选 ${count} 个岗位已在当前发送队列中，请等待依次发送。`
          : data.queued_count
            ? `已将 ${data.queued_count} 个岗位追加到当前发送队列。`
            : `已直接进入发送流程 ${count} 个岗位。`
      )
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '发送失败')
    }
  }

  const openJobDetail = async (job: Job) => {
    try {
      const res = await fetch(`/api/jobs/${job.id}`)
      if (!res.ok) throw new Error('读取岗位详情失败')
      setSelectedJob(await res.json())
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '读取岗位详情失败')
    }
  }

  const downloadResume = (job: Job) => {
    window.open(`/api/jobs/${job.id}/resume/download`, '_blank')
  }

  const markResumeSent = async (job: Job) => {
    try {
      const res = await fetch(`/api/jobs/${job.id}/mark-resume-sent`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || '标记失败')
      }
      await refresh()
      setNotice(`已标记 ${job.company}｜${job.title} 的定制简历已发送。`)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '标记失败')
    }
  }

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted">加载中...</div>
  }

  if (view === 'jobs') {
    return <JobsPoolView />
  }

  if (view === 'monitor') {
    return <MonitorExecutionView history={history} refresh={refresh} />
  }

  return (
    <div className="space-y-5">
      <section id="today-workbench" className="scroll-mt-6 rounded-3xl border border-card-border bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div className="text-xs font-black tracking-[0.18em] text-primary">TODAY WORKBENCH</div>
            <h2 className="mt-1 text-3xl font-black tracking-tight">今日求职行动</h2>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-right">
              <Button variant="secondary" size="sm" onClick={refresh} disabled={refreshing}>
                <RefreshCw className={cn('mr-2 h-4 w-4', refreshing && 'animate-spin')} />
                {refreshing ? '刷新中' : '刷新'}
              </Button>
              {lastRefreshedAt && (
                <div className="mt-1 text-[10px] text-muted">
                  最后刷新：{lastRefreshedAt.toLocaleTimeString('zh-CN', { hour12: false })}
                </div>
              )}
            </div>
            <span className="rounded-full bg-[#FFF0E5] px-3 py-2 text-xs font-black text-primary">
              {activeTasks.length ? `${activeTasks.length} 个任务运行中` : pausedTasks.length ? `${pausedTasks.length} 个任务已暂停` : '当前空闲'}
            </span>
          </div>
        </div>

        {durableScoringRuns.length > 0 && (
          <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {durableScoringRuns.slice(0, 1).map(run => (
              <div key={run.id} className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-black">{run.status === 'paused' ? '评分任务已暂停，可继续' : '评分任务仍在运行'}</div>
                  <div className="mt-1 text-xs">剩余 {run.remaining_job_ids.length} 个岗位。清空岗位池前请先结束或继续该任务。</div>
                  {run.pause_reason && <div className="mt-1 text-xs">原因：{run.pause_reason}</div>}
                  <ScoringProgressPanel progress={run.progress} status={run.status} />
                </div>
                <div className="flex gap-2">
                  {run.status === 'running' && <Button variant="secondary" size="sm" onClick={() => void actOnScoringRun(run, 'pause')}><Pause className="mr-1 h-4 w-4" />暂停评分</Button>}
                  {run.status === 'paused' && run.recoverable && <Button size="sm" onClick={() => void actOnScoringRun(run, 'resume')}><Play className="mr-1 h-4 w-4" />继续评分</Button>}
                  <Button size="sm" variant="secondary" onClick={() => void actOnScoringRun(run, 'end')}><Square className="mr-1 h-4 w-4" />结束评分</Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {durableGreetingRuns.length > 0 && (
          <div className="mb-4 rounded-2xl border border-primary/20 bg-[#FFF0E5] px-4 py-3 text-sm text-primary">
            {durableGreetingRuns.slice(0, 1).map(run => (
              <div key={run.id} className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-black">{run.status === 'paused' ? '招呼语生成已暂停，可继续' : '招呼语生成进行中'}</div>
                  <div className="mt-1 text-xs">剩余 {run.remaining_job_ids.length} 个岗位；已生成内容已保存，可从断点继续。</div>
                  {run.pause_reason && <div className="mt-1 text-xs">原因：{run.pause_reason}</div>}
                  <GreetingProgressPanel
                    progress={greetingProgressFromTask(activeGreetingTask) || run.progress}
                    status={activeGreetingTask?.status || run.status}
                  />
                </div>
                <div className="flex gap-2">
                  {run.status === 'running' && <Button variant="secondary" size="sm" onClick={() => void actOnGreetingRun(run, 'pause')}><Pause className="mr-1 h-4 w-4" />暂停</Button>}
                  {run.status === 'paused' && run.recoverable && <Button size="sm" onClick={() => void actOnGreetingRun(run, 'resume')}><Play className="mr-1 h-4 w-4" />继续生成</Button>}
                  <Button size="sm" variant="secondary" onClick={() => void actOnGreetingRun(run, 'end')}><Square className="mr-1 h-4 w-4" />停止</Button>
                </div>
              </div>
            ))}
          </div>
        )}


        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {modes.map(item => {
            const runningTask = activeTasks.find(task => task.mode === item.mode)
            const isActive = Boolean(runningTask)
            const durableScoreConflict = item.mode === 'score' && durableScoringRuns.length > 0
            const durableGreetingConflict = item.mode === 'greet' && durableGreetingRuns.length > 0
            const noGreetingTargets = item.mode === 'greet' && todayJobs.length === 0
            const disabled = Boolean(!isActive && (noGreetingTargets || durableScoreConflict || durableGreetingConflict || activeTasks.some(task => modesConflict(item.mode, task))))
            return (
              <button
                key={item.mode}
                onClick={() => {
                  if (isActive) {
                    void handleModeClick(item.mode)
                    return
                  }
                  if (disabled) {
                    const conflict = activeTasks.find(task => modesConflict(item.mode, task))
                    setNotice(noGreetingTargets
                      ? '今天暂时没有待确认岗位可生成招呼语。'
                      : durableScoreConflict
                      ? '已有独立评分任务正在运行或等待恢复，请先在提示卡片中继续或结束它。'
                      : durableGreetingConflict
                        ? '已有招呼语生成任务正在运行或等待恢复，请先在提示卡片中继续或结束它。'
                      : `当前正在运行${conflict?.label || '冲突任务'}，该模式暂不能启动；AI 评分和招呼语可与采集并行。`)
                    return
                  }
                  if (item.mode === 'collect' || item.mode === 'full') {
                    setCollectDialogMode(item.mode)
                    setCollectDialogOpen(true)
                  }
                  else void handleModeClick(item.mode)
                }}
                aria-disabled={disabled}
                className={`min-h-[126px] rounded-3xl p-5 text-left transition ${
                  isActive
                    ? 'border-2 border-primary bg-primary text-white shadow-xl shadow-primary/20'
                    : disabled
                      ? 'cursor-not-allowed border border-card-border bg-white text-muted opacity-45'
                      : 'border border-card-border bg-[#FFFCFA] text-foreground hover:border-primary/60 hover:shadow-md'
                }`}
              >
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="text-lg font-black">
                    {modePending === item.mode
                      ? isActive ? '任务停止中' : '任务启动中'
                      : isActive ? `${item.title}中` : item.title}
                  </div>
                  {isActive ? <Square className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5" />}
                </div>
                <p className={`text-xs leading-6 ${isActive ? 'text-white/85' : 'text-muted'}`}>
                  {item.description}
                  {item.mode === 'greet' && ` 当前 ${todayJobs.length} 个今日待确认岗位`}
                </p>
              </button>
            )
          })}
        </div>
        {notice && <div className="mt-3 rounded-2xl bg-[#FFF0E5] px-4 py-3 text-sm text-primary">{notice}</div>}
        {(activeTasks.length > 1 || (activeTasks.length > 0 && pausedTasks.length > 0) || hasAdditionalPausedTasks) && (
          <div className="mt-3 rounded-3xl border border-primary/20 bg-[#FFFCFA] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-black">并行任务</div>
                <p className="mt-1 text-xs text-muted">互不冲突的 AI、采集和本地处理任务可以同时运行；投递与监测仍共用浏览器安全通道。暂停的任务会保留断点。</p>
              </div>
              <span className="rounded-full bg-[#FFF0E5] px-3 py-1 text-xs font-black text-primary">
                {activeTasks.length} 个运行中{pausedTasks.length ? ` · ${pausedTasks.length} 个已暂停` : ''}
              </span>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {activeTasks.filter(task => task.id !== activeTask?.id).map(task => (
                <div key={task.id} className="rounded-2xl border border-card-border bg-white px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-black">{task.label}</div>
                      <div className="mt-1 text-xs text-muted">{taskStatusText(task.status)} · {task.logs?.[task.logs.length - 1] || '后台处理中'}</div>
                    </div>
                    <div className="flex gap-1">
                      {task.status === 'running' && <Button variant="secondary" size="sm" onClick={() => void pauseTask(task.id).then(() => setNotice(`已请求暂停${task.label}。`)).catch(err => setNotice(err instanceof Error ? err.message : '暂停失败'))}>暂停</Button>}
                      {(task.status === 'running' || task.status === 'pausing' || task.status === 'paused') && <Button variant="ghost" size="sm" onClick={() => void stopTask(task.id).then(() => setNotice(`已请求停止${task.label}。`)).catch(err => setNotice(err instanceof Error ? err.message : '停止失败'))}>停止</Button>}
                    </div>
                  </div>
                </div>
              ))}
              {pausedTasks.filter(task => task.id !== visibleTask?.id).map(task => (
                <div key={task.id} className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-black">{task.label}</div>
                      <div className="mt-1 text-xs text-amber-800">已暂停 · {task.stop_reason || '可从断点继续'}</div>
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" onClick={() => {
                        if (task.mode === 'collect' || task.mode === 'full') {
                          setResumingTaskId(task.id)
                          setCollectDialogMode(task.mode)
                          setCollectDialogOpen(true)
                          return
                        }
                        void resumeTask(task.id).then(resumed => { trackCompletionTask(resumed); setNotice(`已从断点继续${task.label}。`) }).catch(err => setNotice(err instanceof Error ? err.message : '继续执行失败'))
                      }}><Play className="mr-1 h-4 w-4" />继续</Button>
                      <Button variant="ghost" size="sm" onClick={() => void stopTask(task.id).then(() => setNotice(`已停止${task.label}。`)).catch(err => setNotice(err instanceof Error ? err.message : '停止失败'))}>停止</Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {preflightChecks.some(check => check.status !== 'pass') && (
          <PreflightPanel checks={preflightChecks} checking={Boolean(modePending)} onRetry={retryPreflight} />
        )}
        {error && <div className="mt-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-danger">{error}</div>}
        {visibleTask && (
          <div className="mt-3 rounded-3xl border border-card-border bg-[#FFFCFA] p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="text-sm font-black">任务运行状态</div>
                <p className="mt-1 text-xs leading-5 text-muted">如果点击后浏览器没有反应，请先打开 BOSS 直聘并确认已登录；常见失败原因是 BOSS 未登录或 Chrome 调试连接不可用。</p>
              </div>
              <span className="rounded-full bg-[#FFF0E5] px-3 py-1 text-xs font-black text-primary">
                {visibleTask.label}
              </span>
            </div>
            <div className={`mt-3 rounded-2xl border px-4 py-3 ${taskStatusClass(visibleTask.status)}`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-black text-primary">{taskStatusTitle(visibleTask.status)}</div>
                  <div className="mt-1 text-lg font-black text-foreground">{currentTaskStage(visibleTask.logs)}</div>
                  <div className="mt-1 text-xs font-bold text-muted">任务状态：{taskStatusText(visibleTask.status)}</div>
                  {visibleTask.checkpoint?.stage && (
                    <div className="mt-1 text-xs text-muted">断点：{checkpointLabel(visibleTask.checkpoint.stage)}</div>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {activeTask && activeTask.status === 'running' && (
                    <Button size="sm" variant="secondary" onClick={() => {
                      void pauseTask(activeTask.id).then(() => setNotice('已请求暂停，正在保存当前断点...')).catch(err => setNotice(err instanceof Error ? err.message : '暂停失败'))
                    }}>
                      <Pause className="mr-2 h-4 w-4" />暂停
                    </Button>
                  )}
                  {pausedTask && (
                    <Button size="sm" onClick={() => {
                      if (visibleTask.mode === 'collect' || visibleTask.mode === 'full') {
                        setResumingTaskId(visibleTask.id)
                        setCollectDialogMode(visibleTask.mode)
                        setCollectDialogOpen(true)
                        return
                      }
                      void resumeTask(visibleTask.id).then(resumed => { trackCompletionTask(resumed); setNotice('已从断点继续执行。') }).catch(err => setNotice(err instanceof Error ? err.message : '继续执行失败'))
                    }}>
                      <Play className="mr-2 h-4 w-4" />继续执行
                    </Button>
                  )}
                  {activeTask && (activeTask.status === 'running' || activeTask.status === 'paused' || activeTask.status === 'pausing') && (
                    <Button size="sm" variant="secondary" onClick={() => {
                      void stopTask(activeTask.id).then(() => setNotice('已请求停止任务。')).catch(err => setNotice(err instanceof Error ? err.message : '停止失败'))
                    }}>
                      <Square className="mr-2 h-4 w-4" />停止
                    </Button>
                  )}
                </div>
              </div>
              {visibleTask.deadline_at && (
                <div className="mt-1 text-xs font-bold text-muted">
                  自动截止：{new Date(visibleTask.deadline_at).toLocaleString('zh-CN', { hour12: false })}
                </div>
              )}
              {visibleTask.metrics && taskMetricItems.some(item => item.key in visibleTask.metrics!) && (
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  {taskMetricItems.map(item => (
                    <div key={item.key} className="rounded-xl border border-card-border bg-white px-3 py-2">
                      <div className="text-[10px] font-bold text-muted">{item.label}</div>
                      <div className="mt-0.5 text-lg font-black text-foreground">{visibleTask.metrics?.[item.key] ?? 0}</div>
                    </div>
                  ))}
                </div>
              )}
              {visibleTask.send_progress && (
                <SendProgressPanel
                  progress={visibleTask.send_progress}
                  status={visibleTask.status}
                />
              )}
              {visibleTask.mode === 'greet' && (
                <GreetingProgressPanel
                  progress={greetingProgressFromTask(visibleTask)}
                  status={visibleTask.status}
                />
              )}
              {visibleTask.mode === 'score' || visibleTask.mode === 'rescore' ? (
                <ScoringProgressPanel progress={visibleTask.scoring_progress} status={visibleTask.status} />
              ) : null}
            </div>
            {visibleTask.progress?.platforms && <CollectionProgressPanel progress={visibleTask.progress} />}
            {visibleTask.error && visibleTaskError && (
              <div className="mt-3 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-danger">
                <div className="font-black">{visibleTaskError.title}</div>
                <p className="mt-1 text-xs leading-5">{visibleTaskError.detail}</p>
                <details className="mt-2 text-xs text-muted">
                  <summary className="cursor-pointer font-bold">查看原始错误</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-white p-2">{visibleTask.error}</pre>
                </details>
              </div>
            )}
            {visibleTask.stop_reason && (
              <div className={`mt-3 rounded-2xl px-3 py-3 text-sm ${visibleTask.stop_reason === 'daily_limit' ? 'border border-amber-200 bg-amber-50 text-amber-800' : 'bg-[#FFF0E5] text-primary'}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-black">{visibleTask.stop_reason === 'daily_limit' ? '本次未发送' : '任务说明'}</div>
                    <div className="mt-1">{taskStopReasonLabel(visibleTask.stop_reason)}</div>
                  </div>
                  {visibleTask.stop_reason === 'daily_limit' && (
                    <Button size="sm" variant="secondary" onClick={() => { window.location.href = '/config?section=throttle' }}>
                      去设置发送额度
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {workbench.send_quota?.exhausted && (
        <section className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-amber-800">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-black">今日发送额度已用完</h3>
              <p className="mt-1 text-sm leading-6">
                今日已发送 {workbench.send_quota.sent}/{workbench.send_quota.daily_limit} 条，未发送岗位已保留在“待发送招呼语”；明日额度恢复后再重试。
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => { window.location.href = '/config?section=throttle' }}>
              去设置发送额度
            </Button>
          </div>
        </section>
      )}

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-black">求职数据</h3>
            <p className="mt-0.5 text-xs text-muted">今日看行动节奏，累计看岗位池沉淀。</p>
          </div>
          <div className="inline-flex rounded-full border border-card-border bg-white p-1">
            {([
              { value: 'today' as const, label: '今日数据' },
              { value: 'total' as const, label: '累计数据' },
            ]).map(option => (
              <button
                key={option.value}
                type="button"
                onClick={() => setStatsScope(option.value)}
                className={`rounded-full px-3 py-1.5 text-xs font-black transition ${
                  statsScope === option.value ? 'bg-primary text-white shadow-sm' : 'text-muted hover:text-primary'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {statItems.map(item => {
            const currentValue = workbench.pending_confirmation.length
            const selectedFunnel = statsScope === 'today' ? workbench.funnel_today : workbench.funnel
            const alternateFunnel = statsScope === 'today' ? workbench.funnel : workbench.funnel_today
            const value = item.current ? currentValue : (selectedFunnel[item.key] || 0)
            const supportingText = item.current
              ? '实时待处理数量'
              : `${statsScope === 'today' ? '累计' : '今日'} ${alternateFunnel[item.key] || 0}`
            return (
              <div key={item.key} className="rounded-2xl border border-card-border bg-white p-4">
                <div className="text-xs text-muted">{statsScope === 'today' ? item.todayLabel : item.totalLabel}</div>
                <div className={`mt-1 text-2xl font-black ${item.highlight ? 'text-primary' : 'text-foreground'}`}>
                  {value}
                </div>
                <div className="mt-1 text-[10px] font-bold text-muted">{supportingText}</div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="rounded-3xl border border-card-border bg-white p-5">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-black">优先处理：HR 要简历 / 定制简历下载</h3>
            <p className="mt-1 text-xs text-muted">首页只展示需要你手动下载并自行发给 HR 的定制简历事项。</p>
          </div>
          <Button variant="secondary" size="sm">查看全部简历事项</Button>
        </div>
        {workbench.needs_resume.length ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {workbench.needs_resume.slice(0, 4).map(job => (
              <div key={job.id} className="rounded-2xl border border-card-border bg-[#FFFCFA] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="font-black">{job.company}｜{job.title}</div>
                  <span className="rounded-full bg-[#FFF0E5] px-2 py-1 text-[11px] font-black text-primary">待发简历</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-muted">HR 已请求简历，系统已准备定制化简历下载入口。</p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" onClick={() => downloadResume(job)}><Download className="mr-2 h-4 w-4" />下载定制简历</Button>
                  <Button variant="secondary" size="sm" onClick={() => markResumeSent(job)}>标记已发送</Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-card-border bg-[#FFFCFA] p-5 text-sm text-muted">当前没有 HR 要简历事项。</div>
        )}
      </section>

      {workbench.send_errors.length > 0 && (
        <section className="rounded-3xl border border-red-100 bg-red-50 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-black text-danger">发送失败待处理</h3>
              <p className="mt-1 text-xs text-danger/80">这些岗位已生成招呼语，但没有成功发送。你可以重试，或放弃已失效岗位。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => sendReadyGreetings(workbench.send_errors.map(job => job.id))}>重新发送全部 {workbench.send_errors.length} 个</Button>
              <Button variant="secondary" size="sm" onClick={() => rejectSelectedJobs(workbench.send_errors.map(job => job.id))}>放弃全部</Button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {workbench.send_errors.map(job => (
              <div key={job.id} className="rounded-2xl border border-red-100 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-black">{job.company}｜{job.title}</div>
                    <div className="mt-1 text-xs text-danger">最近失败原因：{job.last_error || '发送失败，等待重试'}</div>
                  </div>
                  <span className="rounded-full bg-red-50 px-2 py-1 text-[11px] font-black text-danger">发送失败</span>
                </div>
                <p className="mt-3 line-clamp-2 text-sm leading-6 text-muted">{job.greeting || '招呼语已生成，等待重新发送。'}</p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" onClick={() => sendReadyGreetings([job.id])}>重新发送</Button>
                  <Button variant="secondary" size="sm" onClick={() => rejectSelectedJobs([job.id])}>放弃</Button>
                  <Button variant="secondary" size="sm" onClick={() => openJobDetail(job)}><Eye className="mr-2 h-4 w-4" />查看详情</Button>
                  <Button variant="secondary" size="sm" disabled={!job.url} onClick={() => window.open(job.url, '_blank', 'noopener,noreferrer')}><ExternalLink className="mr-2 h-4 w-4" />跳转岗位链接</Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {pendingGreetingJobs.length > 0 && (
        <section className="rounded-3xl border border-primary/20 bg-[#FFF0E5] p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-black">待发送招呼语</h3>
              <p className="mt-1 text-xs text-muted">这些岗位已确认并生成招呼语，点击后会直接进入发送流程。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => sendReadyGreetings(pendingGreetingJobs.map(job => job.id))}>发送全部 {pendingGreetingJobs.length} 个</Button>
              <Button variant="secondary" size="sm" onClick={() => rejectSelectedJobs(pendingGreetingJobs.map(job => job.id))}>放弃全部</Button>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {pendingGreetingJobs.map(job => (
              <div key={job.id} className="rounded-2xl border border-primary/20 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-black">{job.company}｜{job.title}</div>
                    <div className="mt-1 text-xs text-primary">已生成招呼语，等待发送</div>
                  </div>
                  <span className="rounded-full bg-[#FFF0E5] px-2 py-1 text-[11px] font-black text-primary">待发送</span>
                </div>
                <p className="mt-3 line-clamp-2 text-sm leading-6 text-muted">{job.greeting || '招呼语已生成，等待发送。'}</p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" onClick={() => sendReadyGreetings([job.id])}>发送招呼语</Button>
                  <Button variant="secondary" size="sm" onClick={() => rejectSelectedJobs([job.id])}>放弃</Button>
                  <Button variant="secondary" size="sm" onClick={() => openJobDetail(job)}><Eye className="mr-2 h-4 w-4" />查看详情</Button>
                  <Button variant="secondary" size="sm" disabled={!job.url} onClick={() => window.open(job.url, '_blank', 'noopener,noreferrer')}><ExternalLink className="mr-2 h-4 w-4" />跳转岗位链接</Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-3xl border border-card-border bg-white p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-black">今日待确认</h3>
            <p className="mt-1 text-xs text-muted">展示需要你人工确认是否推进投递的岗位，支持全选、部分选择、一键投递。</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void startTodayGreetings()}
              disabled={!todayJobs.length || Boolean(activeGreetingTask || durableGreetingRuns.length) || modePending === 'greet'}
            >
              <MessageCircle className="mr-1 h-4 w-4" />
              {activeGreetingTask || durableGreetingRuns.length ? '招呼语生成中…' : `生成今日招呼语 ${todayJobs.length} 个`}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setSelected(filteredTodayJobs.map(job => job.id))}>全选</Button>
            <Button variant="secondary" size="sm" onClick={() => setSelected([])}>清空</Button>
            <Button variant="secondary" size="sm" onClick={() => rejectSelectedJobs(actionableSelected)}>放弃已选 {actionableSelected.length} 个</Button>
            <Button size="sm" onClick={() => confirmDeliver(actionableSelected)}>一键投递已选 {actionableSelected.length} 个</Button>
          </div>
        </div>
        <JobFilterBar
          filters={todayFilters}
          onChange={setTodayFilters}
          onReset={() => setTodayFilters({ ...EMPTY_JOB_FILTERS })}
          resultCount={filteredTodayJobs.length}
          totalCount={todayJobs.length}
          invalidSalary={hasInvalidSalaryRange(todayFilters)}
        />
        {filteredTodayJobs.length ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {filteredTodayJobs.map(job => (
              <JobActionCard
                key={job.id}
                job={job}
                selected={selected.includes(job.id)}
                onToggle={() => toggleJob(job.id)}
                onDetail={() => openJobDetail(job)}
                onReject={() => rejectSelectedJobs([job.id])}
              />
            ))}
          </div>
        ) : todayJobs.length ? (
          <div className="rounded-2xl border border-dashed border-card-border bg-[#FFFCFA] p-5 text-center text-sm text-muted">
            <p>没有符合当前条件的岗位</p>
            <Button className="mt-3" variant="secondary" size="sm" onClick={() => setTodayFilters({ ...EMPTY_JOB_FILTERS })}>重置筛选</Button>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-card-border bg-[#FFFCFA] p-5 text-sm text-muted">今天暂时没有待确认岗位。</div>
        )}
      </section>

      {selectedJob && <JobDetailModal job={selectedJob} onClose={() => setSelectedJob(null)} />}
      <CollectJobsDialog
        open={collectDialogOpen}
        mode={collectDialogMode}
        activeTask={activeTasks.find(task => task.mode === 'collect' || task.mode === 'full') || null}
        onClose={() => { setCollectDialogOpen(false); setResumingTaskId(null) }}
        onStart={options => void startCollection(options)}
      />
      <TaskCompletionDialog task={completionTask} onConfirm={acknowledgeCompletion} onRetry={retryCompletion} />
    </div>
  )
}

function CollectionProgressPanel({ progress }: { progress: CollectionProgress }) {
  return (
    <div className="mt-3 rounded-2xl border border-primary/20 bg-[#FFF0E5] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-black text-primary">多平台采集进度</div>
        <div className="text-xs font-bold text-muted">{progress.outcome === 'running' ? '执行中' : progress.outcome || '已结束'}</div>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {Object.entries(progress.platforms || {}).map(([platform, state]) => (
          <div key={platform} className="rounded-xl border border-card-border bg-white p-3">
            <div className="flex items-center justify-between text-sm font-black">
              <span>{platform === 'boss' ? 'BOSS 直聘' : platform === 'zhilian' ? '智联招聘' : '前程无忧'}</span>
              <span>新增 {state.new}</span>
            </div>
            <div className="mt-1 text-xs text-muted">
              {state.status === 'queued' ? '等待前序平台完成' : `${state.city || '城市未开始'} · ${state.keyword || '关键词未开始'} · 第 ${state.page || 0}/${state.max_pages || 0} 页`}
            </div>
            <div className="mt-1 text-xs text-muted">扫描 {state.seen || 0} · 重复 {state.duplicate || 0} · 过滤 {state.filtered || 0} · 解析失败 {state.parse_failed || 0} · 保存失败 {state.save_failed || 0}</div>
            {(state.message || state.reason_code) && <div className="mt-1 text-xs font-bold text-primary">{state.message || state.reason_code}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}

function SendProgressPanel({
  progress,
  status = 'running',
}: {
  progress: SendProgress
  status?: string
}) {
  const total = Math.max(Number(progress.total || 0), 0)
  const attempted = Math.min(Math.max(Number(progress.attempted || 0), 0), total || Number(progress.attempted || 0))
  const sent = Math.max(Number(progress.sent || 0), 0)
  const failed = Math.max(Number(progress.failed || 0), 0)
  const deferred = Math.max(Number(progress.deferred || 0), 0)
  const percent = total > 0 ? Math.min(100, Math.round((attempted / total) * 100)) : 0
  const currentJob = progress.current_job
  const isFinished = attempted >= total && total > 0
  const stateLabel = status === 'paused' ? '已暂停'
    : status === 'stopped' || status === 'error' || status === 'failed' ? '已停止'
      : isFinished || status === 'completed' ? '已完成本轮' : '投递中'
  return (
    <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-950">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-black">招呼语投递进度</div>
        <div className="text-xs font-black">共 {total} 个公司 · 已投递 {sent} 个</div>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-emerald-100" role="progressbar" aria-label="招呼语投递进度" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={attempted}>
        <div className="h-full rounded-full bg-emerald-600 transition-[width] duration-200" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-emerald-800">
        <span>已处理 {attempted}/{total || '—'}{failed ? ` · 失败 ${failed} 个` : ''}</span>
        <span>{stateLabel}</span>
      </div>
      {deferred > 0 && (
        <div className="mt-1 text-xs text-emerald-800">另有 {deferred} 个因今日发送额度本轮暂不执行</div>
      )}
      {currentJob ? (
        <div className="mt-2 rounded-xl border border-emerald-200 bg-white px-3 py-2">
          <div className="text-[10px] font-black text-emerald-700">正在投递</div>
          <div className="mt-0.5 truncate text-sm font-black text-foreground">{currentJob.company}｜{currentJob.title}</div>
        </div>
      ) : status === 'running' && !isFinished ? (
        <div className="mt-2 rounded-xl bg-white/70 px-3 py-2 text-xs text-emerald-800">正在准备下一家公司…</div>
      ) : null}
    </div>
  )
}

function greetingProgressFromTask(task: WorkbenchTask | null | undefined): GreetingProgress | null {
  if (!task) return null
  if (task.greeting_progress) return task.greeting_progress
  const metrics = task.metrics || {}
  if (!('greeting_total' in metrics) && !('greeting_generated' in metrics)) return null
  return {
    completed: Number(metrics.greeting_completed || 0),
    total: Number(metrics.greeting_total || metrics.greeting_requested || 0),
    generated: Number(metrics.greeting_generated || 0),
    failed: Number(metrics.greeting_failed || 0),
    current_job: task.current_job || null,
  }
}

function GreetingProgressPanel({
  progress,
  status = 'running',
}: {
  progress?: GreetingProgress | null
  status?: string
}) {
  if (!progress) return null
  const total = Math.max(Number(progress.total || progress.selected || 0), 0)
  const generated = Math.max(Number(progress.generated || 0), 0)
  const completed = Math.max(Number(progress.completed || 0), generated)
  const failed = Math.max(Number(progress.failed || 0), 0)
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0
  const currentJob = progress.current_job
  return (
    <div className="mt-3 rounded-2xl border border-primary/20 bg-white p-3 text-primary">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-black">招呼语生成进度</div>
        <div className="text-xs font-black">共 {total} 个 · 已生成 {generated} 个</div>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#FFF0E5]" role="progressbar" aria-label="招呼语生成进度" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={Math.min(completed, total || completed)}>
        <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>已处理 {completed}/{total || '—'} 个{failed ? ` · 失败 ${failed} 个` : ''}</span>
        <span>{status === 'paused' ? '已暂停' : status === 'completed' ? '已完成' : '生成中'}</span>
      </div>
      {currentJob ? (
        <div className="mt-2 rounded-xl border border-primary/20 bg-[#FFFCFA] px-3 py-2">
          <div className="text-[10px] font-black text-primary">正在生成</div>
          <div className="mt-0.5 truncate text-sm font-black text-foreground">{currentJob.company}｜{currentJob.title}</div>
        </div>
      ) : status === 'running' && completed < total ? (
        <div className="mt-2 rounded-xl bg-[#FFFCFA] px-3 py-2 text-xs text-muted">正在准备下一个岗位…</div>
      ) : null}
    </div>
  )
}

function ScoringProgressPanel({ progress, status = 'running' }: { progress?: ScoringProgress; status?: string }) {
  if (!progress) return null
  const total = Math.max(Number(progress.total || 0), 0)
  const completed = Math.max(Number(progress.completed || 0), 0)
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0
  const activeJobs = Array.isArray(progress.active_jobs) ? progress.active_jobs : []
  return (
    <div className="mt-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sky-950">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-black">AI 评分并行状态</div>
        <div className="text-xs font-black">{activeJobs.length} 个评分工作者 · 已处理 {completed}/{total || '—'}</div>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-sky-100" role="progressbar" aria-label="AI 评分进度" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={Math.min(completed, total || completed)}>
        <div className="h-full rounded-full bg-sky-600 transition-[width] duration-200" style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-sky-800">
        <span>通过 {progress.scored || 0}</span><span>过滤 {progress.filtered || 0}</span><span>失败 {progress.failed || 0}</span>
        <span>{status === 'paused' ? '已暂停' : status === 'completed' ? '已完成' : '评分中'}</span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {activeJobs.length ? activeJobs.map(job => (
          <div key={job.id} className="rounded-xl border border-sky-200 bg-white px-3 py-2">
            <div className="text-[10px] font-black text-sky-700">正在评分</div>
            <div className="mt-0.5 truncate text-sm font-black text-foreground">{job.company}｜{job.title}</div>
          </div>
        )) : (
          <div className="rounded-xl bg-white/70 px-3 py-2 text-xs text-sky-800">正在准备评分岗位…</div>
        )}
      </div>
    </div>
  )
}

function JobActionCard({ job, selected, onToggle, onDetail, onReject }: { job: Job; selected: boolean; onToggle: () => void; onDetail: () => void; onReject: () => void }) {
  return (
    <div className={`rounded-2xl border p-4 ${selected ? 'border-primary bg-[#FFFCFA]' : 'border-card-border bg-[#FFFCFA]'}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-black">{job.company}｜{job.title}</div>
          <div className="mt-1 text-xs text-muted">{jobSubtitle(job)}</div>
        </div>
        <input type="checkbox" checked={selected} onChange={onToggle} className="mt-1 h-4 w-4 accent-primary" />
      </div>
      <p className="mt-3 line-clamp-2 text-sm leading-6 text-muted">{job.score_reason || job.greeting || '等待继续推进。'}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={onDetail}><Eye className="mr-2 h-4 w-4" />查看详情</Button>
        <Button variant="secondary" size="sm" disabled={!job.url} onClick={() => window.open(job.url, '_blank', 'noopener,noreferrer')}><ExternalLink className="mr-2 h-4 w-4" />跳转岗位链接</Button>
        <Button variant="secondary" size="sm" onClick={onReject}><XCircle className="mr-2 h-4 w-4" />放弃岗位</Button>
      </div>
    </div>
  )
}

function JobDetailModal({ job, onClose }: { job: Job; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <div className="max-h-[86vh] w-full max-w-3xl overflow-y-auto rounded-3xl border border-card-border bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-black tracking-[0.18em] text-primary">岗位详情</div>
            <h3 className="mt-1 text-2xl font-black">{job.company}｜{job.title}</h3>
            <p className="mt-1 text-sm text-muted">{job.salary || '薪资未填'} · {job.city || '城市未填'} · {getStatusLabel(job.status)}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
        </div>
        <div className="grid gap-3 text-sm lg:grid-cols-2">
          <InfoBlock label="HR" value={[job.hr_name, job.hr_title].filter(Boolean).join(' · ') || '-'} />
          <InfoBlock label="招聘者活跃" value={job.hr_active || '活跃度未知'} />
          <InfoBlock label="公司" value={[job.company_size, job.company_industry].filter(Boolean).join(' · ') || '-'} />
          <InfoBlock label="来源平台" value={job.source_platform === 'zhilian' ? '智联招聘｜当前只开放采集' : job.source_platform === '51job' ? '前程无忧｜当前只开放采集' : 'BOSS 直聘'} />
          <InfoBlock label="匹配分" value={String(job.score || '-')} />
          <InfoBlock label="定制简历" value={job.resume_path || '未生成'} />
        </div>
        <div className="mt-4 rounded-2xl border border-card-border bg-[#FFFCFA] p-4">
          <div className="text-sm font-black">评分理由</div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted">{job.score_reason || '-'}</p>
        </div>
        <div className="mt-4 rounded-2xl border border-card-border bg-[#FFFCFA] p-4">
          <div className="text-sm font-black">招呼语</div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted">{job.greeting || '未生成'}</p>
        </div>
        <div className="mt-4 rounded-2xl border border-card-border bg-[#FFFCFA] p-4">
          <div className="text-sm font-black">JD</div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted">{job.jd || '-'}</p>
        </div>
      </div>
    </div>
  )
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-card-border bg-[#FFFCFA] p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 font-bold text-foreground">{value}</div>
    </div>
  )
}

function JobsPoolView() {
  const pageSize = 15
  const [page, setPage] = useState(0)
  const [filters, setFilters] = useState<JobFilters>({ ...EMPTY_JOB_FILTERS })
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [showRecycleBin, setShowRecycleBin] = useState(false)
  const [showScoreDialog, setShowScoreDialog] = useState(false)
  const [quickScoring, setQuickScoring] = useState(false)
  const [sortBy, setSortBy] = useState<JobSortKey>('created_at')
  const [sortOrder, setSortOrder] = useState<JobSortOrder>('desc')
  const [recycleJobs, setRecycleJobs] = useState<Job[]>([])
  const [recycleSelectedIds, setRecycleSelectedIds] = useState<string[]>([])
  const [recycleLoading, setRecycleLoading] = useState(false)
  const [permanentDeleteIds, setPermanentDeleteIds] = useState<string[]>([])
  const [permanentDeleteAcknowledged, setPermanentDeleteAcknowledged] = useState(false)
  const [greetingLoading, setGreetingLoading] = useState(false)
  const [completionTaskIds, setCompletionTaskIds] = useState<string[]>([])
  const [clearPoolLoading, setClearPoolLoading] = useState(false)
  const [selectAllLoading, setSelectAllLoading] = useState(false)
  const [clearSelectedLoading, setClearSelectedLoading] = useState(false)
  const { items, total, allTotal, loading, error, refresh: refreshJobs } = useJobSearch(filters, page, pageSize, sortBy, sortOrder)
  const {
    workbench: deliveryWorkbench,
    refresh: refreshWorkbench,
    startTask,
    stopTask,
    pauseTask,
    resumeTask,
    retryTask,
  } = useDashboard('workbench')
  const deliveryTask = deliveryWorkbench.active_tasks?.find(task => task.mode === 'deliver')
    || (deliveryWorkbench.task?.mode === 'deliver' ? deliveryWorkbench.task : null)
    || (deliveryWorkbench.last_task?.mode === 'deliver' ? deliveryWorkbench.last_task : null)
  const scoringRun = deliveryWorkbench.scoring_runs?.[0]
  const greetingRun = deliveryWorkbench.greeting_runs?.[0]
  const greetingTask = deliveryWorkbench.active_tasks?.find(task => task.mode === 'greet')
    || deliveryWorkbench.paused_tasks?.find(task => task.mode === 'greet')
    || (deliveryWorkbench.last_task?.mode === 'greet' && ['running', 'stopping', 'pausing', 'paused'].includes(deliveryWorkbench.last_task.status) ? deliveryWorkbench.last_task : null)
  const greetingRemaining = greetingRun
    ? greetingRun.remaining_job_ids.length
    : Array.isArray(greetingTask?.checkpoint?.remaining_job_ids)
      ? greetingTask.checkpoint.remaining_job_ids.length
      : null
  const todayGreetingIds = useMemo(
    () => new Set((deliveryWorkbench.today_pending_confirmation || deliveryWorkbench.pending_confirmation || []).map(job => job.id)),
    [deliveryWorkbench.today_pending_confirmation, deliveryWorkbench.pending_confirmation],
  )
  const selectedTodayGreetingIds = useMemo(
    () => selectedIds.filter(id => todayGreetingIds.has(id)),
    [selectedIds, todayGreetingIds],
  )

  const taskSnapshots = useMemo(() => {
    const byId = new Map<string, WorkbenchTask>()
    for (const task of [
      ...(deliveryWorkbench.tasks || []),
      ...(deliveryWorkbench.active_tasks || []),
      ...(deliveryWorkbench.paused_tasks || []),
      deliveryWorkbench.task,
      deliveryWorkbench.last_task,
    ]) {
      if (task) byId.set(task.id, task)
    }
    return byId
  }, [deliveryWorkbench.tasks, deliveryWorkbench.active_tasks, deliveryWorkbench.paused_tasks, deliveryWorkbench.task, deliveryWorkbench.last_task])

  const completionTask = useMemo(
    () => completionTaskIds
      .map(id => taskSnapshots.get(id))
      .find(task => Boolean(task && COMPLETION_MODES.has(task.mode) && TERMINAL_TASK_STATUSES.has(task.status))) || null,
    [completionTaskIds, taskSnapshots],
  )

  const trackCompletionTask = (task: WorkbenchTask | null | undefined) => {
    if (!task || !COMPLETION_MODES.has(task.mode)) return
    setCompletionTaskIds(previous => previous.includes(task.id) ? previous : [...previous, task.id])
  }

  const acknowledgeCompletion = () => {
    if (!completionTask) return
    if (completionTask.mode === 'score' || completionTask.mode === 'rescore') setShowScoreDialog(false)
    setCompletionTaskIds(previous => previous.filter(id => id !== completionTask.id))
  }

  const retryCompletion = (task: WorkbenchTask) => {
    setCompletionTaskIds(previous => previous.filter(id => id !== task.id))
    void retryTask(task.id).then(() => setNotice('已重新尝试任务。')).catch(err => setNotice(err instanceof Error ? err.message : '重试失败'))
  }

  const endScoringRun = async () => {
    if (!scoringRun) return
    try {
      const res = await fetch(`/api/scoring/runs/${scoringRun.id}/end`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '结束评分任务失败')
      await refreshWorkbench()
      setNotice('已结束评分任务，岗位池现在可以清空。')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '结束评分任务失败')
    }
  }

  const actOnGreetingTask = async (action: 'pause' | 'resume' | 'stop') => {
    if (!greetingTask) return
    try {
      const task = action === 'pause'
        ? await pauseTask(greetingTask.id)
        : action === 'resume'
          ? await resumeTask(greetingTask.id)
          : await stopTask(greetingTask.id)
      trackCompletionTask(task)
      await refreshWorkbench()
      setNotice(action === 'pause' ? '已请求暂停招呼语生成，正在保存断点。' : action === 'resume' ? '已从招呼语断点继续。' : '已停止招呼语生成任务。')
      return task
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '招呼语任务操作失败')
      return null
    }
  }

  const actOnGreetingRun = async (action: 'pause' | 'resume' | 'end') => {
    if (!greetingRun) return
    try {
      const res = await fetch(`/api/greeting/runs/${greetingRun.id}/${action}`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '招呼语任务操作失败')
      await refreshWorkbench()
      setNotice(action === 'pause' ? '已请求暂停招呼语生成。' : action === 'resume' ? '已从剩余岗位继续生成招呼语。' : '已结束招呼语生成任务。')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '招呼语任务操作失败')
    }
  }

  useEffect(() => {
    setPage(0)
  }, [filters.query, filters.minScore, filters.salaryMin, filters.salaryMax, filters.status, filters.createdWithin, filters.sourcePlatform, filters.education, filters.recruitmentType])

  const toggleSelected = (jobId: string) => {
    setSelectedIds(previous => previous.includes(jobId) ? previous.filter(id => id !== jobId) : [...previous, jobId])
  }

  const allPageSelected = items.length > 0 && items.every(job => selectedIds.includes(job.id))
  const toggleCurrentPage = () => {
    const pageIds = new Set(items.map(job => job.id))
    setSelectedIds(previous => allPageSelected
      ? previous.filter(id => !pageIds.has(id))
      : [...new Set([...previous, ...pageIds])])
  }

  const changeSort = (nextSortBy: JobSortKey) => {
    setPage(0)
    if (nextSortBy === sortBy) {
      setSortOrder(previous => previous === 'asc' ? 'desc' : 'asc')
      return
    }
    setSortBy(nextSortBy)
    setSortOrder(nextSortBy === 'score' || nextSortBy === 'created_at' ? 'desc' : 'asc')
  }

  const loadRecycleBin = async () => {
    setRecycleLoading(true)
    try {
      const collected: Job[] = []
      let offset = 0
      const limit = 200
      while (true) {
        const res = await fetch(`/api/jobs?deleted=only&limit=${limit}&offset=${offset}`, { cache: 'no-store' })
        if (!res.ok) throw new Error(`回收站接口返回 ${res.status}`)
        const pageItems = await res.json()
        if (!Array.isArray(pageItems)) throw new Error('回收站响应格式无效')
        collected.push(...pageItems)
        const totalCount = Number(res.headers.get('X-Total-Count'))
        if (!pageItems.length || pageItems.length < limit || (Number.isFinite(totalCount) && collected.length >= totalCount)) break
        offset += pageItems.length
      }
      const unique = new Map(collected.map(job => [String(job.id), job]))
      setRecycleJobs([...unique.values()])
      setRecycleSelectedIds(previous => previous.filter(id => unique.has(id)))
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '读取回收站失败')
    } finally {
      setRecycleLoading(false)
    }
  }

  useEffect(() => {
    void loadRecycleBin()
  }, [])

  const postJobAction = async (path: string, payload: Record<string, unknown>) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      const blocked = Array.isArray(data.blocked)
        ? data.blocked.map((item: { job_id?: string; reasons?: string[] }) => `${item.job_id || '岗位'}：${(item.reasons || []).join('、')}`).join('；')
        : ''
      throw new Error([data.error || '岗位操作失败', blocked].filter(Boolean).join('；'))
    }
    return res.json()
  }

  const loadFilteredJobIds = async () => {
    const activeFilters = { ...filters }
    const collectedIds: string[] = []
    let offset = 0
    const limit = 100
    while (true) {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      if (activeFilters.query.trim()) params.set('q', activeFilters.query.trim())
      if (activeFilters.minScore) params.set('min_score', activeFilters.minScore)
      if (activeFilters.salaryMin) params.set('salary_min', activeFilters.salaryMin)
      if (activeFilters.salaryMax) params.set('salary_max', activeFilters.salaryMax)
      if (activeFilters.status) params.set('status', activeFilters.status)
      if (activeFilters.createdWithin) params.set('created_within', activeFilters.createdWithin)
      if (activeFilters.sourcePlatform) params.set('source_platform', activeFilters.sourcePlatform)
      if (activeFilters.education) params.set('education', activeFilters.education)
      if (activeFilters.recruitmentType) params.set('recruitment_type', activeFilters.recruitmentType)
      const res = await fetch(`/api/jobs/search?${params.toString()}`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({})) as { items?: Job[]; total?: number; error?: string }
      if (!res.ok) throw new Error(data.error || '读取筛选岗位失败')
      const pageItems = Array.isArray(data.items) ? data.items : []
      collectedIds.push(...pageItems.map(job => job.id))
      if (!pageItems.length || pageItems.length < limit || collectedIds.length >= Number(data.total || 0)) break
      offset += pageItems.length
    }
    return [...new Set(collectedIds)]
  }

  const selectAllFilteredJobs = async () => {
    if (!total || selectAllLoading) return
    setSelectAllLoading(true)
    try {
      const jobIds = await loadFilteredJobIds()
      setSelectedIds(previous => [...new Set([...previous, ...jobIds])])
      setNotice(`已选中当前筛选结果中的 ${jobIds.length} 条岗位。`)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '全选岗位失败')
    } finally {
      setSelectAllLoading(false)
    }
  }

  const softDelete = async (jobIds: string[]) => {
    if (!jobIds.length || !window.confirm(`确认将 ${jobIds.length} 个岗位移入回收站吗？岗位不会永久删除。`)) return
    setClearSelectedLoading(true)
    const completedIds: string[] = []
    let affectedCount = 0
    try {
      for (let start = 0; start < jobIds.length; start += 500) {
        const chunk = jobIds.slice(start, start + 500)
        const result = await postJobAction('/api/jobs/soft-delete', { job_ids: chunk, confirmed: true })
        completedIds.push(...chunk)
        affectedCount += Number(result.affected_count || 0)
      }
      setSelectedIds(previous => previous.filter(id => !completedIds.includes(id)))
      refreshJobs()
      await loadRecycleBin()
      setNotice(`已从岗位池清空 ${affectedCount} 条岗位，已移入回收站。`)
    } catch (cause) {
      if (completedIds.length) {
        setSelectedIds(previous => previous.filter(id => !completedIds.includes(id)))
        refreshJobs()
        await loadRecycleBin()
      }
      const detail = cause instanceof Error ? cause.message : '清空所选岗位失败'
      setNotice(completedIds.length ? `已清空 ${affectedCount} 条岗位，剩余操作失败：${detail}` : detail)
    } finally {
      setClearSelectedLoading(false)
    }
  }

  const clearJobPool = async () => {
    if (!total || clearPoolLoading) return
    if (!window.confirm(`确认清空当前筛选列表中的 ${total} 条岗位吗？未投递且没有回复证据的岗位将被永久删除，以便重新采集；该操作无法恢复，已有投递或回复证据的岗位会保留。`)) return
    setClearPoolLoading(true)
    try {
      const result = await postJobAction('/api/jobs/clear', {
        confirmed: true,
        confirmation: 'CLEAR_JOB_POOL',
        filters: {
          q: filters.query.trim(),
          min_score: filters.minScore,
          salary_min: filters.salaryMin,
          salary_max: filters.salaryMax,
          status: filters.status,
          created_within: filters.createdWithin,
          source_platform: filters.sourcePlatform,
          education: filters.education,
          recruitment_type: filters.recruitmentType,
        },
      })
      setSelectedIds([])
      refreshJobs()
      await loadRecycleBin()
      const protectedCount = Number(result.protected_count || 0)
      setNotice(
        protectedCount
          ? `已清空 ${result.affected_count || 0} 条岗位，保留 ${protectedCount} 条有投递或回复记录的岗位。`
          : `已清空岗位池，共删除 ${result.affected_count || 0} 条岗位，可重新采集。`
      )
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '清空岗位池失败')
    } finally {
      setClearPoolLoading(false)
    }
  }

  const markManuallySent = async (job: Job) => {
    if (job.source_platform !== 'zhilian' && job.source_platform !== '51job') return
    const platformLabel = job.source_platform === 'zhilian' ? '智联招聘' : '前程无忧'
    if (!window.confirm(`请确认：你已经在${platformLabel}完成了这个岗位的投递。此操作只更新 BossHunter 本地记录，不会向平台发送任何内容。`)) return
    try {
      const result = await postJobAction('/api/jobs/manual-sent', {
        job_ids: [job.id],
        confirmed: true,
      })
      refreshJobs()
      setNotice(
        result.affected_count
          ? `已将 ${platformLabel} 岗位标记为“已发送”。`
          : `该岗位此前已经标记为“已发送”。`
      )
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '标记已发送失败')
    }
  }

  const deliverSelectedJobs = async () => {
    if (!selectedIds.length) return
    const count = selectedIds.length
    if (!window.confirm(`确认投递已选择的 ${count} 个岗位吗？仅 BOSS 岗位可进入发送队列，且仍受发送时间窗口和每日额度限制。`)) return
    try {
      const result = await postJobAction('/api/workbench/deliver', { job_ids: selectedIds })
      trackCompletionTask(taskSnapshot(result))
      setSelectedIds([])
      refreshJobs()
      setNotice(
        result.already_queued_count === count
          ? `所选 ${count} 个岗位已在当前发送队列中。`
          : result.queued_count
            ? `已将 ${result.queued_count} 个岗位追加到当前发送队列。`
            : `已确认投递 ${count} 个岗位，后端会按安全队列推进。`
      )
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '一键投递失败')
    }
  }

  const restoreJobs = async (jobIds: string[]) => {
    if (!jobIds.length || !window.confirm(`确认恢复 ${jobIds.length} 个岗位吗？恢复后不会自动评分或投递。`)) return
    try {
      const result = await postJobAction('/api/jobs/restore', { job_ids: jobIds, confirmed: true })
      setRecycleSelectedIds(previous => previous.filter(id => !jobIds.includes(id)))
      refreshJobs()
      await loadRecycleBin()
      setNotice(`已恢复 ${result.affected_count || 0} 条岗位。`)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '恢复失败')
    }
  }

  const requestPermanentDelete = (jobIds: string[]) => {
    if (!jobIds.length) return
    setPermanentDeleteIds(jobIds)
    setPermanentDeleteAcknowledged(false)
  }

  const confirmPermanentDelete = async () => {
    if (!permanentDeleteIds.length || !permanentDeleteAcknowledged) return
    try {
      const result = await postJobAction('/api/jobs/permanent-delete', {
        job_ids: permanentDeleteIds,
        confirmed: true,
        confirmation: 'PERMANENT_DELETE',
      })
      setRecycleSelectedIds(previous => previous.filter(id => !permanentDeleteIds.includes(id)))
      setPermanentDeleteIds([])
      setPermanentDeleteAcknowledged(false)
      await loadRecycleBin()
      setNotice(`已永久删除 ${result.affected_count || 0} 条岗位。`)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '永久删除失败')
    }
  }

  const exportJobs = async (format: 'xlsx' | 'csv', scope: 'all' | 'filtered' | 'selected') => {
    try {
      const res = await fetch('/api/jobs/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format,
          scope,
          job_ids: scope === 'selected' ? selectedIds : [],
          filters: scope === 'filtered' ? {
            q: filters.query.trim(),
            min_score: filters.minScore,
            salary_min: filters.salaryMin,
            salary_max: filters.salaryMax,
            status: filters.status,
            created_within: filters.createdWithin,
            source_platform: filters.sourcePlatform,
          } : {},
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || '导出失败')
      }
      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') || ''
      const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `bosshunter-jobs.${format}`
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
      window.URL.revokeObjectURL(url)
      const exportedCount = Number(res.headers.get('X-Exported-Count'))
      setNotice(`已导出 ${Number.isFinite(exportedCount) ? exportedCount : 0} 条岗位。`)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '导出失败')
    }
  }

  const startScoring = async (options: {
    scope: 'pending' | 'failed' | 'selected' | 'all_scored'
    limit: number | null
    job_ids: string[]
    force_rescore: boolean
  }) => {
    const res = await fetch('/api/scoring/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ options }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const checks = Array.isArray(data.messages) ? data.messages.join('；') : ''
      throw new Error([data.error || '启动评分失败', checks].filter(Boolean).join('：'))
    }
    trackCompletionTask(taskSnapshot(data.task))
    setNotice(`独立评分已启动，共 ${data.run?.remaining_job_ids?.length || 0} 个岗位。`)
  }

  const startQuickScoring = async () => {
    if (!window.confirm('将对岗位池中所有未评分或评分失败的岗位启动 AI 评分，可能产生模型费用，是否继续？')) return
    setQuickScoring(true)
    try {
      await startScoring({ scope: 'pending', limit: null, job_ids: [], force_rescore: false })
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '启动 AI 评分失败')
    } finally {
      setQuickScoring(false)
    }
  }

  const startSelectedGreetings = async () => {
    if (!selectedTodayGreetingIds.length) {
      setNotice('单独生成招呼语只能处理“今日待确认”中的岗位，请先选择今日岗位。')
      return
    }
    if (!window.confirm(`将为今日待确认中的 ${selectedTodayGreetingIds.length} 个岗位生成招呼语，不会立即发送，是否继续？`)) return
    setGreetingLoading(true)
    try {
      const task = await startTask('greet', { scope: 'today_pending', job_ids: selectedTodayGreetingIds })
      trackCompletionTask(task)
      setNotice(`已启动今日待确认岗位的招呼语生成，共 ${selectedTodayGreetingIds.length} 个岗位；完成后可单独投递。`)
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '启动招呼语生成失败')
    } finally {
      setGreetingLoading(false)
    }
  }

  if (showRecycleBin) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => setShowRecycleBin(false)}>返回岗位池</Button>
          <Button variant="secondary" size="sm" onClick={() => void loadRecycleBin()} disabled={recycleLoading}>刷新回收站</Button>
        </div>
        {notice && <div className="rounded-xl bg-[#FFF0E5] px-4 py-3 text-sm text-primary">{notice}</div>}
        <RecycleBinPanel
          jobs={recycleJobs}
          selectedIds={recycleSelectedIds}
          loading={recycleLoading}
          onToggleSelected={id => setRecycleSelectedIds(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id])}
          onSelectAll={setRecycleSelectedIds}
          onRestore={ids => void restoreJobs(ids)}
          onPermanentDelete={requestPermanentDelete}
        />
        {permanentDeleteIds.length > 0 && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" role="dialog" aria-modal="true">
            <div className="w-full max-w-lg rounded-3xl border border-red-200 bg-white p-6 shadow-2xl">
              <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-6 w-6 shrink-0 text-danger" /><div><h3 className="text-xl font-black">确认永久删除</h3><p className="mt-2 text-sm leading-6 text-muted">将永久删除 {permanentDeleteIds.length} 条岗位及其历史，无法恢复。存在发送或回复证据的岗位会被后端拒绝删除。</p></div></div>
              <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-2xl border border-red-100 bg-red-50 p-3 text-sm font-bold"><input type="checkbox" checked={permanentDeleteAcknowledged} onChange={event => setPermanentDeleteAcknowledged(event.target.checked)} className="mt-0.5 h-4 w-4 accent-danger" /><span>我确认永久删除，并了解此操作无法撤销。</span></label>
              <div className="mt-6 flex justify-end gap-3"><Button variant="secondary" size="sm" onClick={() => setPermanentDeleteIds([])}>取消</Button><Button variant="destructive" size="sm" disabled={!permanentDeleteAcknowledged} onClick={() => void confirmPermanentDelete()}>永久删除</Button></div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="rounded-3xl border border-card-border bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-black">岗位池</h2>
          <p className="mt-1 text-sm text-muted">集中查看已采集岗位、AI 分数、状态和详情入口。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="destructive" size="sm" onClick={() => void clearJobPool()} disabled={!total || clearPoolLoading}>
            <XCircle className="mr-1 h-4 w-4" />{clearPoolLoading ? '清空中…' : '清空岗位池'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => { setShowRecycleBin(true); void loadRecycleBin() }}><Trash2 className="mr-1 h-4 w-4" />回收站 ({recycleJobs.length})</Button>
          <BriefcaseBusiness className="h-6 w-6 text-primary" />
        </div>
      </div>
      <JobFilterBar
        filters={filters}
        onChange={setFilters}
        onReset={() => setFilters({ ...EMPTY_JOB_FILTERS })}
        resultCount={total}
        totalCount={allTotal}
        invalidSalary={hasInvalidSalaryRange(filters)}
        showStatus
        showSource
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <Button variant="secondary" size="sm" disabled={!items.length} onClick={toggleCurrentPage}>
          {allPageSelected ? '取消选择本页' : '选择本页'}
        </Button>
        <Button variant="secondary" size="sm" disabled={!total || selectAllLoading} onClick={() => void selectAllFilteredJobs()}>
          {selectAllLoading ? '全选中…' : '一键全选筛选结果'}
        </Button>
        <span className="rounded-full bg-[#FFF0E5] px-3 py-2 font-bold text-primary">已选择 {selectedIds.length} 条</span>
        {selectedIds.length > 0 && <Button variant="ghost" size="sm" onClick={() => setSelectedIds([])}>清空选择</Button>}
        <Button variant="destructive" size="sm" disabled={!selectedIds.length || clearSelectedLoading} onClick={() => void softDelete(selectedIds)}>
          {clearSelectedLoading ? '清空中…' : '清空所选岗位'}
        </Button>
        <Button size="sm" disabled={!selectedIds.length} onClick={() => void deliverSelectedJobs()}>
          <Send className="mr-1 h-4 w-4" />BOSS 一键投递已选
        </Button>
        <Button size="sm" onClick={() => void startQuickScoring()} disabled={quickScoring || !total}>
          {quickScoring ? '启动评分中…' : '一键 AI 评分'}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void startSelectedGreetings()} disabled={greetingLoading || !selectedTodayGreetingIds.length}>
          {greetingLoading ? '生成中…' : '生成已选今日招呼语'}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setShowScoreDialog(true)}>评分选项</Button>
        <ExportMenu onExport={exportJobs} hasSelection={selectedIds.length > 0} hasFiltered={total > 0} />
      </div>
      {notice && <div className="mb-4 rounded-xl bg-[#FFF0E5] px-4 py-3 text-sm text-primary">{notice}</div>}
      {scoringRun && (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-black">{scoringRun.status === 'paused' ? '评分任务已暂停，可继续' : '评分任务仍在运行'}</div>
              <div className="mt-1 text-xs">剩余 {scoringRun.remaining_job_ids.length} 个岗位。清空岗位池前请先结束该任务。</div>
            </div>
            <div className="flex gap-2">
              {scoringRun.status === 'paused' && scoringRun.recoverable && (
                <Button size="sm" onClick={() => void fetch(`/api/scoring/runs/${scoringRun.id}/resume`, { method: 'POST' }).then(async response => {
                  const data = await response.json().catch(() => ({}))
                  if (!response.ok) throw new Error(data.error || '继续评分失败')
                  trackCompletionTask(taskSnapshot(data.task))
                  await refreshWorkbench()
                  setNotice('已从评分断点继续。')
                }).catch(err => setNotice(err instanceof Error ? err.message : '继续评分失败'))}><Play className="mr-1 h-4 w-4" />继续评分</Button>
              )}
              {scoringRun.status === 'running' && (
                <Button size="sm" variant="secondary" onClick={() => void fetch(`/api/scoring/runs/${scoringRun.id}/pause`, { method: 'POST' }).then(async response => {
                  const data = await response.json().catch(() => ({}))
                  if (!response.ok) throw new Error(data.error || '暂停评分失败')
                  await refreshWorkbench()
                  setNotice('已请求暂停评分，当前完成结果会保留。')
                }).catch(err => setNotice(err instanceof Error ? err.message : '暂停评分失败'))}><Pause className="mr-1 h-4 w-4" />暂停</Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => void endScoringRun()}><Square className="mr-1 h-4 w-4" />结束评分</Button>
            </div>
          </div>
        </div>
      )}
      {(greetingRun || greetingTask) && (
        <div className="mb-4 rounded-2xl border border-primary/20 bg-[#FFF0E5] px-4 py-3 text-sm text-primary">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-black">{greetingRun?.status === 'paused' || greetingTask?.status === 'paused' ? '招呼语生成已暂停，可继续' : '招呼语生成进行中'}</div>
              <div className="mt-1 text-xs">剩余 {greetingRemaining ?? '—'} 个岗位；已生成内容会保留。</div>
              {(greetingRun?.pause_reason || greetingTask?.stop_reason) && <div className="mt-1 text-xs">原因：{greetingRun?.pause_reason || greetingTask?.stop_reason}</div>}
              <GreetingProgressPanel
                progress={greetingProgressFromTask(greetingTask) || greetingRun?.progress}
                status={greetingTask?.status || greetingRun?.status}
              />
            </div>
            <div className="flex gap-2">
              {greetingRun?.status === 'running' && <Button size="sm" variant="secondary" onClick={() => void actOnGreetingRun('pause')}><Pause className="mr-1 h-4 w-4" />暂停</Button>}
              {greetingRun?.status === 'paused' && greetingRun.recoverable && <Button size="sm" onClick={() => void actOnGreetingRun('resume')}><Play className="mr-1 h-4 w-4" />继续生成</Button>}
              {!greetingRun && greetingTask?.status === 'running' && <Button size="sm" variant="secondary" onClick={() => void actOnGreetingTask('pause')}><Pause className="mr-1 h-4 w-4" />暂停</Button>}
              {!greetingRun && greetingTask?.status === 'paused' && <Button size="sm" onClick={() => void actOnGreetingTask('resume')}><Play className="mr-1 h-4 w-4" />继续生成</Button>}
              {(greetingRun || greetingTask) && <Button size="sm" variant="secondary" onClick={() => greetingRun ? void actOnGreetingRun('end') : void actOnGreetingTask('stop')}><Square className="mr-1 h-4 w-4" />停止</Button>}
            </div>
          </div>
        </div>
      )}
      {deliveryTask && (
        <div className="mb-4 rounded-2xl border border-card-border bg-[#FFFCFA] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-black">投递队列</div>
              <p className="mt-1 text-xs text-muted">只展示已人工确认的 BOSS 发送任务；智联和 51job 不会进入此队列。</p>
            </div>
            <span className="rounded-full bg-[#FFF0E5] px-3 py-1 text-xs font-black text-primary">
              {deliveryTask.status === 'running' ? '处理中' : deliveryTask.status === 'completed' ? '已完成' : deliveryTask.status === 'failed' ? '失败' : deliveryTask.status}
            </span>
          </div>
          <div className="mt-3 rounded-xl border border-card-border bg-white px-3 py-2 text-sm">
            <div className="font-bold">{deliveryTask.logs?.[deliveryTask.logs.length - 1] || '队列已创建，等待执行'}</div>
            <div className="mt-1 text-xs text-muted">任务 ID：{deliveryTask.id}</div>
          </div>
        </div>
      )}
      {error && <div className="mb-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-danger">{error}</div>}
      <JobsTable
        jobs={items}
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        selectedIds={selectedIds}
        onToggleSelected={toggleSelected}
        onSoftDelete={job => void softDelete([job.id])}
        onMarkManuallySent={job => void markManuallySent(job)}
        loading={loading}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onSortChange={changeSort}
      />
      <ScoreJobsDialog
        open={showScoreDialog}
        selectedJobIds={selectedIds}
        onClose={() => setShowScoreDialog(false)}
        onStart={startScoring}
      />
      <TaskCompletionDialog task={completionTask} onConfirm={acknowledgeCompletion} onRetry={retryCompletion} />
    </div>
  )
}

function ExportMenu({
  onExport,
  hasSelection,
  hasFiltered,
}: {
  onExport: (format: 'xlsx' | 'csv', scope: 'all' | 'filtered' | 'selected') => void
  hasSelection: boolean
  hasFiltered: boolean
}) {
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx')
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2">
      <select
        value={format}
        onChange={event => setFormat(event.target.value as 'xlsx' | 'csv')}
        className="rounded-xl border border-card-border bg-white px-2 py-2 text-xs outline-none focus:border-primary"
      >
        <option value="xlsx">XLSX</option>
        <option value="csv">CSV</option>
      </select>
      <Button variant="secondary" size="sm" disabled={!hasFiltered} onClick={() => onExport(format, 'filtered')}>导出筛选结果</Button>
      <Button variant="secondary" size="sm" disabled={!hasSelection} onClick={() => onExport(format, 'selected')}>导出所选岗位</Button>
      <Button variant="secondary" size="sm" onClick={() => onExport(format, 'all')}>导出全部岗位</Button>
    </div>
  )
}

type MonitorFilter = 'pending' | 'resume' | 'follow_up' | 'replied'
const REPLY_RESOLUTION_ACTIONS = ['reply_dismissed', 'replied', 'auto_replied']

function uniqueLatestByJob(items: HistoryItem[]) {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = item.job_id || `${item.company}-${item.title}-${item.action}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function sameHistoryJob(left: HistoryItem, right: HistoryItem) {
  if (left.job_id && right.job_id) return left.job_id === right.job_id
  return left.company === right.company && left.title === right.title
}

function isReplyPendingResolved(item: HistoryItem, history: HistoryItem[]) {
  return history.some(candidate =>
    candidate.id !== item.id
    && sameHistoryJob(item, candidate)
    && REPLY_RESOLUTION_ACTIONS.includes(candidate.action)
    && candidate.created_at >= item.created_at
  )
}

function isResumeFailureResolved(item: HistoryItem, history: HistoryItem[]) {
  return Boolean(item.resolved || item.resume_path) || history.some(candidate =>
    candidate.id > item.id
    && sameHistoryJob(item, candidate)
    && (candidate.action === 'needs_resume' || candidate.action === 'resume_sent')
  )
}

function latestHrText(item: HistoryItem) {
  const parsed = parseHistoryDetail(item)
  const latestHr = [...parsed.conversationTail].reverse().find(message => message.sender === 'hr' && message.text.trim())
  return parsed.hrQuestion || latestHr?.text || ''
}

function MonitorExecutionView({ history, refresh }: { history: HistoryItem[]; refresh: () => Promise<void> }) {
  const pendingReplies = uniqueLatestByJob(history.filter(item =>
    item.action === 'reply_pending' && !isReplyPendingResolved(item, history)
  ))
  const resumeFailures = uniqueLatestByJob(history.filter(item =>
    item.action === 'resume_failed' && !isResumeFailureResolved(item, history)
  ))
  const pendingItems = uniqueLatestByJob(
    [...pendingReplies, ...resumeFailures].sort((left, right) => right.id - left.id)
  )
  const resumeRequests = uniqueLatestByJob(history.filter(item =>
    item.action === 'needs_resume' || item.action === 'resume_sent' || item.action === 'resume_failed'
  ))
  const resumeRequestJobIds = new Set(resumeRequests.map(item => item.job_id).filter(Boolean))
  const followUpRecords = uniqueLatestByJob(history.filter(item => item.action === 'follow_up_sent'))
  const repliedRecords = uniqueLatestByJob(history.filter(item =>
    (item.action === 'replied' || item.action === 'auto_replied')
      && !resumeRequestJobIds.has(item.job_id)
  ))
  const [activeMonitorFilter, setActiveMonitorFilter] = useState<MonitorFilter>('pending')
  const visibleHistory = activeMonitorFilter === 'resume'
    ? resumeRequests
    : activeMonitorFilter === 'follow_up'
      ? followUpRecords
      : activeMonitorFilter === 'replied'
        ? repliedRecords
        : pendingItems
  const displayedHistory = activeMonitorFilter === 'pending' || activeMonitorFilter === 'resume'
    ? visibleHistory
    : visibleHistory.slice(0, 8)
  const [replyDrafts, setReplyDrafts] = useState<Record<number, string>>({})
  const [notice, setNotice] = useState('')

  const draftFor = (item: HistoryItem) => {
    const parsed = parseHistoryDetail(item)
    return replyDrafts[item.id] ?? parsed.aiReply ?? item.detail ?? ''
  }

  const sendManualReply = async (item: HistoryItem) => {
    try {
      const res = await fetch(`/api/history/${item.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: draftFor(item) }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || '回复失败')
      }
      await refresh()
      setNotice('回复已记录，请在招聘平台手动发送。')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '回复失败')
    }
  }

  const dismissPendingReply = async (item: HistoryItem) => {
    if (!window.confirm('确定放弃这条待回复建议吗？放弃后不会发送消息，也不会把岗位标记为拒绝。')) return
    try {
      const res = await fetch(`/api/history/${item.id}/dismiss`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || '放弃失败')
      }
      await refresh()
      setNotice('已放弃这条待回复建议。')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '放弃失败')
    }
  }

  return (
    <div className="rounded-3xl border border-card-border bg-white p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black">监测执行</h2>
          <p className="mt-1 text-sm text-muted">这里不启动监测，只处理监测发现的 HR 问题、回复建议和结果。</p>
        </div>
        <span className="rounded-full bg-[#FFF0E5] px-3 py-2 text-xs font-black text-primary">待处理 {pendingItems.length}</span>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        {[
          { key: 'pending' as const, label: '待处理', count: pendingItems.length },
          { key: 'resume' as const, label: '简历请求', count: resumeRequests.length },
          { key: 'follow_up' as const, label: '自动跟进', count: followUpRecords.length },
          { key: 'replied' as const, label: '已回复', count: repliedRecords.length },
        ].map(item => {
          const active = activeMonitorFilter === item.key
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setActiveMonitorFilter(item.key)}
              className={`rounded-full px-3 py-1 text-xs font-bold transition ${active ? 'bg-primary text-white' : 'border border-card-border text-muted hover:border-primary/60 hover:text-primary'}`}
            >
              {item.label} {item.count}
            </button>
          )
        })}
      </div>
      {notice && <div className="mb-3 rounded-2xl bg-[#FFF0E5] px-4 py-3 text-sm text-primary">{notice}</div>}
      <div className="space-y-3">
        {displayedHistory.map((item, index) => {
          const canReply = item.action === 'reply_pending'
          const isFollowUp = item.action === 'follow_up_sent'
          const isResumeFailure = item.action === 'resume_failed'
          const isResumeRequest = item.action === 'needs_resume' || item.action === 'resume_sent' || isResumeFailure
          const isReplied = item.action === 'replied' || item.action === 'auto_replied'
          const parsed = parseHistoryDetail(item)
          const hrText = latestHrText(item)
          const isLegacyReplied = item.action === 'replied' && parsed.schema === 'legacy_text'
          const hasGeneratedReply = Boolean(parsed.aiReply) && !isLegacyReplied
          const showReplyContent = canReply || Boolean(parsed.hrQuestion) || hasGeneratedReply || isResumeRequest || isReplied
          const aiReplyText = parsed.aiReply || item.detail || getActionLabel(item.action)
          const systemFailureReason = parsed.systemReason || (isResumeFailure ? '未获得更具体的错误信息，请查看运行日志。' : '')
          return (
            <div key={`${item.created_at}-${index}`} className="grid gap-3 rounded-2xl border border-card-border bg-[#FFFCFA] p-4 lg:grid-cols-[130px_1fr_160px]">
              <div className="text-xs text-muted">
                <div>{item.created_at}</div>
                <div className="mt-2 rounded-full bg-white px-2 py-1 text-center font-bold text-primary">{getActionLabel(item.action)}</div>
              </div>
              <div>
                <div className="font-black">{item.company || '岗位'}｜{item.title || '监测记录'}</div>
                {showReplyContent ? (
                  <div className="mt-3 space-y-3">
                    {(isFollowUp || hrText) && (
                      <div>
                        <div className="text-xs font-black text-primary">{isFollowUp ? '自动跟进说明' : '对方问题 / HR'}</div>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted">
                          {isFollowUp ? 'HR 超过设定时间未回复，系统已自动执行一次跟进。' : hrText}
                        </p>
                      </div>
                    )}
                    {isResumeFailure && (
                      <div className="rounded-2xl border border-danger/30 bg-red-50 p-3">
                        <div className="text-xs font-black text-danger">系统失败原因</div>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-danger">{systemFailureReason}</p>
                      </div>
                    )}
                    {canReply ? (
                      <div>
                        <div className="mb-1 text-xs font-black text-primary">AI 建议回复</div>
                        <textarea
                          value={draftFor(item)}
                          onChange={event => setReplyDrafts(prev => ({ ...prev, [item.id]: event.target.value }))}
                          className="min-h-[92px] w-full rounded-2xl border border-card-border bg-white p-3 text-sm leading-6 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                        />
                      </div>
                    ) : isResumeRequest || !hasGeneratedReply ? null : (
                      <div className="rounded-2xl border border-card-border bg-white p-3">
                        <div className="text-xs font-black text-primary">AI 回复</div>
                        <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted">{aiReplyText}</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 text-sm leading-6 text-muted">{item.detail || getActionLabel(item.action)}</p>
                )}
                {canReply ? (
                  <p className="mt-2 text-xs text-primary">AI 建议：需要人工确认后再回复。</p>
                ) : item.action === 'needs_resume' ? (
                  <p className="mt-2 text-xs text-primary">简历请求：监测发现 HR 要简历，已生成定制简历，等待手动发送。</p>
                ) : item.action === 'resume_sent' ? (
                  <p className="mt-2 text-xs text-primary">简历生成：定制简历已生成，并已标记发送。</p>
                ) : isResumeFailure ? (
                  <p className="mt-2 text-xs text-danger">待处理：定制简历生成失败，尚无可下载文件，请手动处理或稍后重试生成。</p>
                ) : isReplied ? (
                  <p className="mt-2 text-xs text-primary">已回复：HR 已有反馈或系统已完成回复处理。</p>
                ) : null}
              </div>
              <div className="grid gap-2">
                <Button size="sm" disabled={!canReply} onClick={() => sendManualReply(item)}><MessageCircle className="mr-2 h-4 w-4" />确认回复</Button>
                <Button variant="secondary" size="sm" disabled={!canReply} onClick={() => setReplyDrafts(prev => ({ ...prev, [item.id]: draftFor(item) }))}>编辑回复</Button>
                <Button variant="secondary" size="sm" disabled={!canReply} onClick={() => dismissPendingReply(item)}>放弃</Button>
              </div>
            </div>
          )
        })}
        {!visibleHistory.length && <div className="rounded-2xl border border-dashed border-card-border bg-[#FFFCFA] p-5 text-sm text-muted">暂无待处理 HR 问题。</div>}
      </div>
    </div>
  )
}
