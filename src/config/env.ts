/**
 * Cấu hình runtime — đọc từ biến môi trường, validate bằng zod.
 * Fail-fast khi thiếu biến quan trọng: KHÔNG khởi động với cấu hình sai.
 */

import { z } from 'zod';
import 'dotenv/config';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PREFIX: z.string().default('/api/v1'),

  DATABASE_URL: z.string().min(10),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().int().min(0).default(0),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET phải dài tối thiểu 32 ký tự'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET phải dài tối thiểu 32 ký tự'),
  JWT_ACCESS_TTL: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().positive().default(1_209_600),
  REFRESH_COOKIE_NAME: z.string().default('amis_rt'),
  REFRESH_COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(12).default(10),

  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),

  DATA_ENCRYPTION_KEY: z.string().min(32, 'DATA_ENCRYPTION_KEY phải là 32 bytes (hex 64 ký tự)'),

  GEO_MAX_ACCURACY_METERS: z.coerce.number().positive().default(65),
  GEO_HARD_RADIUS_METERS: z.coerce.number().positive().default(200),
  GEO_WIFI_BSSID_REQUIRED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  ATTENDANCE_GRACE_MINUTES: z.coerce.number().int().min(0).default(10),
  ATTENDANCE_PAIR_WINDOW_BEFORE_MIN: z.coerce.number().int().min(0).default(180),
  ATTENDANCE_PAIR_WINDOW_AFTER_MIN: z.coerce.number().int().min(0).default(240),
  LIVENESS_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.62),

  PAYROLL_TAX_REGIME: z.string().default('AUTO'),
  PAYROLL_MIN_WAGE_REGION: z.enum(['I', 'II', 'III', 'IV']).default('I'),
  PAYROLL_STANDARD_WORK_HOURS: z.coerce.number().positive().default(8),
  PAYROLL_STANDARD_WORK_DAYS: z.coerce.number().positive().default(26),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('AMIS HRM <no-reply@example.com>'),

  DEVICE_PUSH_TOKEN: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema> & {
  corsOriginList: string[];
  isProduction: boolean;
};

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Cấu hình môi trường không hợp lệ:\n${details}`);
  }
  const raw = parsed.data;
  cached = {
    ...raw,
    corsOriginList: raw.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    isProduction: raw.NODE_ENV === 'production',
  };
  return cached;
}

/** Reset cache — chỉ dùng trong test */
export function resetConfigCache(): void {
  cached = null;
}
