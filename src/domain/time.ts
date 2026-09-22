/**
 * Tiện ích thời gian phục vụ chấm công. Toàn bộ xử lý dựa trên
 * "phút trong ngày" (minutes-of-day) + số ngày lệch (dayOffset) để xử lý
 * đúng các ca vắt qua 0h mà không bị lỗi DST/timezone.
 *
 * QUY ƯỚC MŨI GIỜ: hệ thống lưu UTC trong DB, còn mọi tính toán ca kíp
 * thực hiện trên GIỜ ĐỊA PHƯƠNG của trụ sở (mặc định Asia/Ho_Chi_Minh,
 * UTC+07:00, không có DST).
 */

export const MIN_PER_DAY = 24 * 60;
export const TZ_DEFAULT = 'Asia/Ho_Chi_Minh';

/** "08:30" -> 510. Chấp nhận "24:00" => 1440. */
export function parseTimeOfDay(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(hhmm.trim());
  if (!m) throw new Error(`Định dạng giờ không hợp lệ: "${hhmm}" (cần HH:mm)`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59) throw new Error(`Giờ ngoài phạm vi: "${hhmm}"`);
  if (h === 24 && mi !== 0) throw new Error(`Giờ ngoài phạm vi: "${hhmm}"`);
  return h * 60 + mi;
}

/** 510 -> "08:30" */
export function formatTimeOfDay(minutes: number): string {
  const m = ((Math.round(minutes) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  const h = Math.floor(m / 60);
  const mi = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/** Số phút trong ngày (giờ địa phương) của một Date */
export function minutesOfDayUtc(d: Date): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
}

/**
 * Chuyển Date (UTC) sang biểu diễn tại múi giờ cố định không DST (UTC+7).
 * Trả về { date: 'YYYY-MM-DD', minutes: 0..1440, ts }.
 */
export interface LocalMoment {
  date: string; // YYYY-MM-DD tại múi giờ địa phương
  minutes: number; // phút trong ngày tại múi giờ địa phương
  /** epoch ms đã dịch để các phép tính Date trở thành số học địa phương */
  localTs: number;
}

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export function toLocalMoment(d: Date | string | number, offsetMs = VN_OFFSET_MS): LocalMoment {
  const ts = new Date(d).getTime();
  const localTs = ts + offsetMs;
  const ld = new Date(localTs);
  const date = ld.toISOString().slice(0, 10);
  const minutes = ld.getUTCHours() * 60 + ld.getUTCMinutes() + ld.getUTCSeconds() / 60000;
  return { date, minutes, localTs };
}

/** Chuỗi local 'YYYY-MM-DD HH:mm' -> epoch ms UTC */
export function fromLocal(dateStr: string, minutes: number, offsetMs = VN_OFFSET_MS): Date {
  const base = new Date(`${dateStr}T00:00:00.000Z`).getTime();
  return new Date(base + Math.round(minutes) * 60_000 - offsetMs);
}

export function addDays(dateStr: string, days: number): string {
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00.000Z`).getTime();
  const db = new Date(`${b}T00:00:00.000Z`).getTime();
  return Math.round((da - db) / 86_400_000);
}

/** Giao của 2 khoảng [a1,a2] và [b1,b2]; null nếu không giao */
export function overlap(a1: number, a2: number, b1: number, b2: number): [number, number] | null {
  const lo = Math.max(a1, b1);
  const hi = Math.min(a2, b2);
  return hi > lo ? [lo, hi] : null;
}

/** Số phút giao nhau (0 nếu không giao) */
export function overlapMinutes(a1: number, a2: number, b1: number, b2: number): number {
  const r = overlap(a1, a2, b1, b2);
  return r ? r[1] - r[0] : 0;
}

/** 0=Chủ nhật .. 6=Thứ bảy (tính trên ngày local) */
export function dayOfWeek(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
}

export function isWeekend(dateStr: string): boolean {
  const dow = dayOfWeek(dateStr);
  return dow === 0 || dow === 6;
}

/** Số phút giữa 2 LocalMoment (có dấu, a - b) */
export function minutesBetween(a: LocalMoment, b: LocalMoment): number {
  return (a.localTs - b.localTs) / 60_000;
}

/** Làm tròn phút xuống bội số step */
export function floorMinutes(minutes: number, step: number): number {
  if (step <= 0) return minutes;
  return Math.floor(minutes / step) * step;
}
