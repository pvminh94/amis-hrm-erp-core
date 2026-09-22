/**
 * ============================================================================
 * RESOLVE CA KÍP — xử lý trọn vẹn ca hành chính, ca đêm vắt 0h, ca gãy,
 *                  và hệ xoay 3 ca 4 kíp.
 * ============================================================================
 *
 * Mô hình: một ca (ShiftDefinition) gồm 1..N "đoạn" (segment).
 * Mỗi đoạn có:
 *   - startMin  : phút trong ngày của giờ VÀO (0..1440)
 *   - endMin    : phút trong ngày của giờ RA (0..1440)
 *   - endDayOffset: 0 nếu ra cùng ngày, 1 nếu ra ngày hôm sau (CA ĐÊM VẮT 0h)
 *   - isNight   : đoạn có nằm trong khung giờ đêm pháp lý (22:00–06:00)
 *
 * Ví dụ:
 *   Hành chính  : 1 đoạn  08:00 → 17:00 (nghỉ trưa 12:00–13:00 => breakMin 60)
 *   Ca gãy      : 2 đoạn  08:00→12:00 và 14:00→18:00
 *   Ca đêm      : 1 đoạn  22:00 → 06:00 (+1 ngày)   <-- CROSS-MIDNIGHT
 *   3 ca 4 kíp  : CA1 06:00→14:00, CA2 14:00→22:00, CA3 22:00→06:00(+1)
 *
 * Mọi thời điểm được biểu diễn bằng absoluteLocalMinute =
 *   (số ngày kể từ mốc) * 1440 + phút trong ngày
 * nên việc so sánh/ghép cặp không bao giờ bị nhầm khi qua 0h.
 */

import { MIN_PER_DAY, addDays, formatTimeOfDay, overlapMinutes, parseTimeOfDay } from './time.js';

export interface ShiftSegmentDef {
  name: string;
  /** "HH:mm" */
  start: string;
  /** "HH:mm" — có thể nhỏ hơn start => tự hiểu là qua ngày hôm sau */
  end: string;
  /** Ghi đè tường minh: 1 = giờ ra thuộc ngày kế tiếp */
  endDayOffset?: number;
  /** Giờ nghỉ giữa đoạn (phút) — trừ khỏi giờ công */
  breakMinutes?: number;
}

export interface ShiftDef {
  code: string;
  name: string;
  type: 'OFFICE' | 'NIGHT_CROSS_DAY' | 'SPLIT' | 'ROTATING' | 'FLEXIBLE';
  segments: ShiftSegmentDef[];
  /** Khung giờ đêm pháp lý: mặc định 22:00 (1320) → 06:00 (360) */
  nightStartMin?: number;
  nightEndMin?: number;
  /** Số giờ công chuẩn của ca (để tính lương giờ). Null => tự tính */
  standardHours?: number | null;
}

export interface ResolvedSegment {
  index: number;
  name: string;
  startMin: number;
  endMin: number;
  /** 1 nếu giờ ra thuộc ngày workDate+1 */
  endDayOffset: number;
  /** Phút tuyệt đối (so với 00:00 ngày workDate) */
  absStart: number;
  absEnd: number;
  /** Phút nghỉ giữa đoạn */
  breakMinutes: number;
  /** Số phút công thực của đoạn (đã trừ nghỉ) */
  netMinutes: number;
  /** Số phút của đoạn rơi vào khung giờ đêm */
  nightMinutes: number;
  isNightSegment: boolean;
  startClock: string;
  endClock: string;
}

export interface ResolvedShift {
  code: string;
  name: string;
  type: ShiftDef['type'];
  /** Ngày công vụ (work date) — ca đêm 22:00 ngày D có workDate = D */
  workDate: string;
  segments: ResolvedSegment[];
  absStart: number;
  absEnd: number;
  /** Tổng phút công chuẩn (đã trừ nghỉ) */
  totalNetMinutes: number;
  totalNetHours: number;
  /** Số công chuẩn quy đổi (1 công = 8h) */
  standardDays: number;
  /** Tổng phút rơi vào khung giờ đêm => phụ cấp 30% */
  nightMinutes: number;
  nightHours: number;
  crossMidnight: boolean;
  /** Ngày lịch của giờ vào / giờ ra (chuỗi YYYY-MM-DD) */
  startDate: string;
  endDate: string;
  nightStartMin: number;
  nightEndMin: number;
}

const DEFAULT_NIGHT_START = 22 * 60; // 1320
const DEFAULT_NIGHT_END = 6 * 60; // 360
const STANDARD_DAY_HOURS = 8;

/**
 * Số phút giao giữa khoảng [from, to) (phút tuyệt đối) và khung giờ đêm
 * [nightStart, nightEnd) lặp lại mỗi ngày.
 *
 * Khung đêm 22:00–06:00 được "trải" thành các khoảng tuyệt đối:
 *   [d*1440+1320, d*1440+1800)  cho d = dayIndex-1, dayIndex, dayIndex+1
 * (22:00 ngày D đến 06:00 ngày D+1 = 480 phút)
 */
export function nightOverlapMinutes(
  fromAbs: number,
  toAbs: number,
  nightStartMin = DEFAULT_NIGHT_START,
  nightEndMin = DEFAULT_NIGHT_END,
): number {
  if (toAbs <= fromAbs) return 0;
  const nightLen = nightEndMin + (MIN_PER_DAY - nightStartMin); // 360 + 240 = 600? => 480
  if (nightLen <= 0) return 0;

  const firstDay = Math.floor(fromAbs / MIN_PER_DAY) - 1;
  const lastDay = Math.floor(toAbs / MIN_PER_DAY) + 1;
  let total = 0;
  for (let d = firstDay; d <= lastDay; d += 1) {
    const nStart = d * MIN_PER_DAY + nightStartMin;
    const nEnd = nStart + nightLen;
    total += overlapMinutes(fromAbs, toAbs, nStart, nEnd);
  }
  return total;
}

/** Mở một định nghĩa đoạn thành khoảng thời gian tuyệt đối đã resolve */
function resolveSegment(
  def: ShiftSegmentDef,
  index: number,
  nightStart: number,
  nightEnd: number,
): ResolvedSegment {
  const startMin = parseTimeOfDay(def.start);
  let endMin = parseTimeOfDay(def.end);
  let endDayOffset = def.endDayOffset ?? 0;

  // Suy luận tự động: giờ ra <= giờ vào => qua ngày hôm sau
  if (def.endDayOffset === undefined && endMin <= startMin) {
    endDayOffset = 1;
  }
  // Nếu giờ ra trùng giờ vào và offset=0 => ca 0 phút, báo lỗi
  if (endDayOffset === 0 && endMin <= startMin) {
    throw new Error(
      `Đoạn "${def.name}" của ca có giờ ra (${def.end}) không sau giờ vào (${def.start})`,
    );
  }

  const absStartMin = startMin;
  const absEndMin = endDayOffset * MIN_PER_DAY + endMin;
  const breakMinutes = Math.max(0, def.breakMinutes ?? 0);
  const grossMinutes = absEndMin - absStartMin;
  if (breakMinutes >= grossMinutes) {
    throw new Error(`Đoạn "${def.name}": giờ nghỉ (${breakMinutes}') >= tổng thời lượng ca`);
  }
  const netMinutes = grossMinutes - breakMinutes;
  const nightMinutes = nightOverlapMinutes(absStartMin, absEndMin, nightStart, nightEnd);

  return {
    index,
    name: def.name,
    startMin,
    endMin,
    endDayOffset,
    absStart: absStartMin,
    absEnd: absEndMin,
    breakMinutes,
    netMinutes,
    nightMinutes,
    isNightSegment: nightMinutes > 0,
    startClock: formatTimeOfDay(startMin),
    endClock: formatTimeOfDay(endMin),
  };
}

/**
 * "Mở" định nghĩa ca thành các khoảng thời gian tuyệt đối cho một ngày công vụ.
 */
export function resolveShift(def: ShiftDef, workDate: string): ResolvedShift {
  if (!def.segments || def.segments.length === 0) {
    throw new Error(`Ca "${def.code}" không có đoạn giờ nào`);
  }
  const nightStart = def.nightStartMin ?? DEFAULT_NIGHT_START;
  const nightEnd = def.nightEndMin ?? DEFAULT_NIGHT_END;

  const segments: ResolvedSegment[] = def.segments.map((seg, i) =>
    resolveSegment(seg, i, nightStart, nightEnd),
  );

  // Sắp theo giờ vào; các đoạn không được chồng lấn
  segments.sort((a, b) => a.absStart - b.absStart);
  for (let i = 1; i < segments.length; i += 1) {
    const prev = segments[i - 1]!;
    const cur = segments[i]!;
    if (cur.absStart < prev.absEnd) {
      throw new Error(
        `Ca "${def.code}": đoạn "${cur.name}" (${cur.startClock}) chồng lấn đoạn "${prev.name}" (kết thúc ${prev.endClock})`,
      );
    }
  }
  segments.forEach((s, i) => {
    s.index = i;
  });

  const absStart = segments[0]!.absStart;
  const absEnd = segments[segments.length - 1]!.absEnd;
  const totalNetMinutes = segments.reduce((acc, s) => acc + s.netMinutes, 0);
  const nightMinutes = segments.reduce((acc, s) => acc + s.nightMinutes, 0);
  const crossMidnight = segments.some((s) => s.endDayOffset > 0);

  const explicitStandard =
    def.standardHours !== null && def.standardHours !== undefined
      ? def.standardHours * 60
      : null;
  const effectiveNet = explicitStandard ?? totalNetMinutes;

  const first = segments[0]!;
  const last = segments[segments.length - 1]!;

  return {
    code: def.code,
    name: def.name,
    type: def.type,
    workDate,
    segments,
    absStart,
    absEnd,
    totalNetMinutes,
    totalNetHours: totalNetMinutes / 60,
    standardDays: effectiveNet / 60 / STANDARD_DAY_HOURS,
    nightMinutes,
    nightHours: nightMinutes / 60,
    crossMidnight,
    startDate: workDate,
    endDate: last.endDayOffset > 0 ? addDays(workDate, last.endDayOffset) : workDate,
    nightStartMin: nightStart,
    nightEndMin: nightEnd,
    // giữ tham chiếu đoạn đầu để debug
    ...(first ? {} : {}),
  };
}

/**
 * Đổi phút tuyệt đối (so với 00:00 ngày workDate) thành ngày lịch + phút trong ngày.
 */
export function absToCalendar(workDate: string, absMinute: number): { date: string; minutes: number } {
  const dayOffset = Math.floor(absMinute / MIN_PER_DAY);
  const minutes = absMinute - dayOffset * MIN_PER_DAY;
  return { date: dayOffset === 0 ? workDate : addDays(workDate, dayOffset), minutes };
}

/**
 * Đổi ngày lịch + phút trong ngày thành phút tuyệt đối so với workDate.
 */
export function calendarToAbs(workDate: string, date: string, minutes: number, dayDiff: number): number {
  return dayDiff * MIN_PER_DAY + minutes;
}

// ---------------------------------------------------------------------------
// HỆ XOAY 3 CA 4 KÍP
// ---------------------------------------------------------------------------

/**
 * Mẫu xoay mặc định "3 ca 4 kíp" phổ biến tại nhà máy VN:
 * chu kỳ 8 ngày — Sáng / Chiều / Đêm / Nghỉ (theo kíp).
 *
 * pattern[i] = mã ca của ngày thứ i trong chu kỳ; 'REST' = nghỉ.
 */
export const ROTATION_3CA_4KIP = {
  code: 'ROT_3CA4KIP',
  name: 'Xoay 3 ca 4 kíp — chu kỳ 8 ngày',
  cycleLength: 8,
  pattern: ['CA1', 'CA1', 'CA2', 'CA2', 'CA3', 'CA3', 'REST', 'REST'],
} as const;

/** 4 kíp lệch pha nhau 2 ngày trong cùng chu kỳ 8 ngày */
export const ROTATION_TEAMS = ['KIP_A', 'KIP_B', 'KIP_C', 'KIP_D'] as const;

/**
 * Xác định mã ca của một nhân sự trong hệ 3 ca 4 kíp.
 * @param workDate Ngày cần tra
 * @param anchorDate Ngày neo chu kỳ (ngày bắt đầu tính)
 * @param teamIndex Chỉ số kíp 0..3 (lệch pha teamIndex*2 ngày)
 */
export function resolveRotationShiftCode(
  workDate: string,
  anchorDate: string,
  teamIndex: number,
  rotation: { cycleLength: number; pattern: readonly string[] } = ROTATION_3CA_4KIP,
): string | null {
  if (!Number.isInteger(teamIndex) || teamIndex < 0) {
    throw new Error(`teamIndex phải là số nguyên không âm, nhận: ${teamIndex}`);
  }
  const a = new Date(`${anchorDate}T00:00:00.000Z`).getTime();
  const w = new Date(`${workDate}T00:00:00.000Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(w)) {
    throw new Error(`Ngày không hợp lệ: anchor=${anchorDate}, work=${workDate}`);
  }
  const rawDays = Math.round((w - a) / 86_400_000);
  const cycle = rotation.cycleLength;
  const phaseShift = (teamIndex * 2) % cycle;
  // Đảm bảo index không âm kể cả khi workDate trước anchorDate
  const idx = (((rawDays - phaseShift) % cycle) + cycle) % cycle;
  const code = rotation.pattern[idx];
  return code === 'REST' ? null : (code ?? null);
}
