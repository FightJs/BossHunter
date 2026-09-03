import { CheckCircle2, CircleAlert, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { WorkbenchTask } from '@/hooks/useDashboard'

interface TaskCompletionDialogProps {
  task: WorkbenchTask | null
  onConfirm: () => void
  onRetry?: (task: WorkbenchTask) => void
}

const terminalCopy: Record<string, { title: string; description: string; icon: typeof CheckCircle2; iconClass: string }> = {
  completed: {
    title: '任务已完成',
    description: '已完成的结果已经保存。确认后关闭此提示。',
    icon: CheckCircle2,
    iconClass: 'text-emerald-600',
  },
  failed: {
    title: '任务未完成',
    description: '请查看错误信息；确认后关闭此提示。',
    icon: CircleAlert,
    iconClass: 'text-danger',
  },
  stopped: {
    title: '任务已停止',
    description: '已完成的部分结果会保留。确认后关闭此提示。',
    icon: XCircle,
    iconClass: 'text-muted',
  },
}

const metricLabels: Record<string, string> = {
  collect_seen: '本轮扫描',
  collect_new: '本轮新增',
  collect_duplicate: '重复岗位',
  collect_filtered: '过滤岗位',
  collect_parse_failed: '解析失败',
  collect_save_failed: '保存失败',
  ai_completed: '评分已处理',
  ai_total: '评分总数',
  ai_passed: 'AI 通过',
  ai_filtered: 'AI 过滤',
  ai_failed: 'AI 失败',
  greeting_requested: '招呼语请求',
  greeting_completed: '招呼语已处理',
  greeting_generated: '招呼语已生成',
  greeting_failed: '招呼语失败',
  send_requested: '投递请求',
  send_success: '发送成功',
  send_failed: '发送失败',
  send_deferred: '待下次发送',
  send_remaining_quota: '剩余发送额度',
}

export function TaskCompletionDialog({ task, onConfirm, onRetry }: TaskCompletionDialogProps) {
  if (!task || !['completed', 'failed', 'stopped'].includes(task.status)) return null

  const copy = terminalCopy[task.status] || terminalCopy.completed
  const Icon = copy.icon
  const metrics = Object.entries(task.metrics || {}).filter(([, value]) => value > 0)
  const latestLog = task.logs?.[task.logs.length - 1]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-labelledby="task-completion-title">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <Icon className={`mt-0.5 h-6 w-6 shrink-0 ${copy.iconClass}`} aria-hidden="true" />
          <div>
            <p className="text-xs font-black tracking-[0.14em] text-primary">{task.label}</p>
            <h2 id="task-completion-title" className="mt-1 text-xl font-black">{copy.title}</h2>
            <p className="mt-2 text-sm leading-6 text-muted">{copy.description}</p>
          </div>
        </div>
        {(latestLog || task.error) && (
          <div className="mt-4 rounded-xl bg-[#FFFCFA] px-4 py-3 text-sm">
            <div className="font-bold">{latestLog || '任务已结束'}</div>
            {task.error && <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-danger">{task.error}</p>}
            {task.logs && task.logs.length > 1 && (
              <details className="mt-3 text-xs text-muted">
                <summary className="cursor-pointer font-bold">查看完整日志</summary>
                <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto whitespace-pre-wrap break-words pl-4">
                  {task.logs.map((log, index) => <li key={`${index}-${log}`}>{log}</li>)}
                </ul>
              </details>
            )}
          </div>
        )}
        {metrics.length > 0 && (
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {metrics.slice(0, 6).map(([key, value]) => (
              <div key={key} className="rounded-xl bg-[#FFF0E5] px-3 py-2">
                <div className="text-[10px] font-bold text-muted">{metricLabels[key] || key}</div>
                <div className="mt-0.5 text-lg font-black text-foreground">{value}</div>
              </div>
            ))}
          </div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          {task.status === 'failed' && onRetry && <Button variant="secondary" onClick={() => onRetry(task)}>重试</Button>}
          <Button onClick={onConfirm}>确定</Button>
        </div>
      </div>
    </div>
  )
}
