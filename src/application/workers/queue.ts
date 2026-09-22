/**
 * ============================================================================
 * JOB QUEUE — BullMQ / Redis
 * ============================================================================
 *
 * Các hàng đợi của hệ thống:
 *   sync-raw-punch      : đồng bộ nhật ký quẹt thẻ thô từ thiết bị
 *   close-night-shift   : chốt công đêm vắt 0h (chạy 06:30 hằng ngày)
 *   send-payslip-mail   : gửi phiếu lương điện tử
 *   calc-progressive-tax: tính thuế luỹ tiến hàng loạt cho cả bảng lương
 *   post-gl-journal     : sinh bút toán kế toán kép
 *   export-payment-file : xuất file UNC theo ngân hàng
 *   liveness-rescan     : quét lại điểm chống giả mạo
 *
 * Mỗi job đều có: retry với backoff, jobId idempotent, và bản ghi đối soát
 * trong bảng queue_jobs (để dashboard vận hành hiển thị khi Redis bị flush).
 */

import { Queue, Worker, type ConnectionOptions, type JobsOptions, type Processor } from 'bullmq';

export const QUEUE_NAMES = {
  syncRawPunch: 'sync-raw-punch',
  closeNightShift: 'close-night-shift',
  sendPayslipMail: 'send-payslip-mail',
  calcProgressiveTax: 'calc-progressive-tax',
  postGlJournal: 'post-gl-journal',
  exportPaymentFile: 'export-payment-file',
  livenessRescan: 'liveness-rescan',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export function redisConnection(): ConnectionOptions {
  return {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB ?? 0),
    maxRetriesPerRequest: null, // bắt buộc cho BullMQ
  };
}

export interface QueueDefaults {
  attempts: number;
  backoffMs: number;
  removeOnComplete: number;
  removeOnFail: number;
}

export const DEFAULT_QUEUE_OPTIONS: QueueDefaults = {
  attempts: 5,
  backoffMs: 10_000,
  removeOnComplete: 5_000,
  removeOnFail: 10_000,
};

export function defaultJobOptions(overrides: Partial<JobsOptions> = {}): JobsOptions {
  return {
    attempts: DEFAULT_QUEUE_OPTIONS.attempts,
    backoff: { type: 'exponential', delay: DEFAULT_QUEUE_OPTIONS.backoffMs },
    removeOnComplete: DEFAULT_QUEUE_OPTIONS.removeOnComplete,
    removeOnFail: DEFAULT_QUEUE_OPTIONS.removeOnFail,
    ...overrides,
  };
}

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName, connection?: ConnectionOptions): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: connection ?? redisConnection(),
      defaultJobOptions: defaultJobOptions(),
    });
    queues.set(name, q);
  }
  return q;
}

/**
 * Thêm job với jobId idempotent — gửi lặp cùng khoá sẽ KHÔNG tạo job mới.
 * Quan trọng với thiết bị chấm công vốn gửi lại log nhiều lần khi mất mạng.
 */
export async function enqueueIdempotent<T>(
  name: QueueName,
  jobKey: string,
  data: T,
  options: Partial<JobsOptions> = {},
): Promise<{ id: string; deduplicated: boolean }> {
  const queue = getQueue(name);
  const jobId = `${name}:${jobKey}`;
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'waiting' || state === 'active' || state === 'delayed') {
      return { id: jobId, deduplicated: true };
    }
  }
  await queue.add(name, data, defaultJobOptions({ jobId, ...options }));
  return { id: jobId, deduplicated: false };
}

/** Job lặp (cron) cho các tác vụ theo lịch */
export interface RepeatableJobDef {
  name: QueueName;
  jobKey: string;
  pattern: string; // cron expression
  tz?: string;
  data?: unknown;
}

export const SCHEDULED_JOBS: readonly RepeatableJobDef[] = [
  {
    name: QUEUE_NAMES.closeNightShift,
    jobKey: 'daily-night-shift-close',
    // 06:30 mỗi ngày — sau khi ca đêm 22:00→06:00 kết thúc
    pattern: '30 6 * * *',
    tz: 'Asia/Ho_Chi_Minh',
  },
  {
    name: QUEUE_NAMES.calcProgressiveTax,
    jobKey: 'monthly-tax-batch',
    // 23:00 ngày cuối tháng do worker tự kiểm tra; cron chạy mùng 1 để chốt kỳ trước
    pattern: '0 23 1 * *',
    tz: 'Asia/Ho_Chi_Minh',
  },
];

export async function registerRepeatableJobs(): Promise<void> {
  for (const def of SCHEDULED_JOBS) {
    const queue = getQueue(def.name);
    await queue.upsertJobScheduler(
      `${def.name}:${def.jobKey}`,
      { pattern: def.pattern, tz: def.tz },
      { name: def.jobKey, data: def.data ?? {}, opts: defaultJobOptions({ jobId: undefined }) },
    );
  }
}

export function createWorker<T>(
  name: QueueName,
  processor: Processor<T>,
  concurrency = 4,
): Worker<T> {
  return new Worker<T>(name, processor, {
    connection: redisConnection(),
    concurrency,
    lockDuration: 60_000,
    stalledInterval: 30_000,
  });
}

export async function closeAllQueues(): Promise<void> {
  for (const q of queues.values()) await q.close();
  queues.clear();
}
