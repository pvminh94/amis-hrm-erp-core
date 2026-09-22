/**
 * ============================================================================
 * THUẬT TOÁN GHÉP CẶP QUẺT THẺ (PUNCH PAIRING) & TÍNH CÔNG NGÀY
 * ============================================================================
 *
 * Xử lý:
 *   1. Cửa sổ ghép cặp (pairing window) quanh ca kế hoạch — loại quẹt rác.
 *   2. Gán quẹt vào từng ĐOẠN ca (hỗ trợ CA GÃY nhiều đoạn).
 *   3. Phân loại IN/OUT theo vị trí so với điểm giữa đoạn, rồi ghép
 *      FIRST-IN / LAST-OUT trong từng đoạn.
 *   4. CA ĐÊM VẮT 0h: dùng phút tuyệt đối nên 22:00(D) → 06:00(D+1) là
 *      một khoảng liên tục, không bao giờ bị âm.
 *   5. GRACE PERIOD: đi trễ trong ngưỡng không phạt.
 *   6. Phân loại giờ làm thêm 150% / 200% / 300% theo loại ngày, và tách
 *      giờ OT ban đêm (hệ số 300/200/150 + 30% + 20%).
 *   7. BÙ CÔNG từ đơn giải trình / công tác đã duyệt.
 *
 * Thuật toán này THUẦN (pure) — không phụ thuộc DB, dễ kiểm thử 100%.
 */

import type { ResolvedShift } from './shift-resolution.js';
import { nightOverlapMinutes } from './shift-resolution.js';
import { MIN_PER_DAY } from './time.js';

// ---------------------------------------------------------------------------
// KIỂU DỮ LIỆU
// ---------------------------------------------------------------------------

export type CalendarDayKind = 'WORKING_DAY' | 'WEEKLY_REST' | 'PUBLIC_HOLIDAY' | 'PAID_LEAVE';

export interface PunchLike {
  /** Thời điểm quẹt, dạng phút tuyệt đối SO VỚI 00:00 ngày workDate.
   *  (quẹt 06:00 ngày hôm sau của ca đêm = 1800) */
  absMinute: number;
  /** Hướng do thiết bị khai báo (nếu có). null => hệ thống tự suy luận. */
  direction?: 'IN' | 'OUT' | null;
  source?: string;
  /** true = bản ghi được sinh ra từ đơn giải trình/công tác đã duyệt */
  isRegularization?: boolean;
}

export interface PairingConfig {
  /** Mở cửa sổ ghép cặp về trước giờ vào (phút) */
  windowBeforeMin: number;
  /** Mở cửa sổ ghép cặp về sau giờ ra (phút) */
  windowAfterMin: number;
  /** Đi trễ trong ngưỡng này không bị phạt */
  graceMinutes: number;
  /** Đi trễ thêm bao nhiêu phút nữa thì coi là vắng nửa ngày */
  halfDayAfterLateMin: number;
  /** Đi trễ quá ngưỡng này => coi là vắng cả ngày */
  absentAfterLateMin: number;
  /** Về sớm trong ngưỡng này không tính thiếu công */
  earlyLeaveToleranceMin: number;
  /** Số giờ công chuẩn/ngày để quy đổi công (thường 8) */
  standardDayHours: number;
  /** Có cho phép ghép cặp tự do khi không bám được đoạn */
  allowFreePairing: boolean;
}

export const DEFAULT_PAIRING_CONFIG: PairingConfig = {
  windowBeforeMin: 180,
  windowAfterMin: 240,
  graceMinutes: 10,
  halfDayAfterLateMin: 120,
  absentAfterLateMin: 240,
  earlyLeaveToleranceMin: 0,
  standardDayHours: 8,
  allowFreePairing: true,
};

export interface PairedSegment {
  index: number;
  name: string;
  /** Giờ vào/ra kế hoạch (phút tuyệt đối) */
  plannedIn: number;
  plannedOut: number;
  /** Giờ vào/ra thực tế (phút tuyệt đối), null = thiếu quẹt */
  actualIn: number | null;
  actualOut: number | null;
  /** Phút công thực (đã trừ nghỉ, đã kẹp vào khoảng hợp lệ) */
  workedMinutes: number;
  /** Phút công rơi vào khung giờ đêm */
  nightMinutes: number;
  /** Thiếu quẹt vào / ra */
  missingIn: boolean;
  missingOut: boolean;
  /** Nguồn dữ liệu: PUNCH | REGULARIZATION | INFERRED */
  inSource: 'PUNCH' | 'REGULARIZATION' | 'INFERRED' | null;
  outSource: 'PUNCH' | 'REGULARIZATION' | 'INFERRED' | null;
}

export type AttendanceResultStatus =
  | 'PRESENT'
  | 'LATE'
  | 'ABSENT'
  | 'HALF_DAY'
  | 'MISSING_PUNCH'
  | 'WEEKLY_OFF'
  | 'HOLIDAY_OFF'
  | 'LEAVE_PAID';

export interface AttendanceResult {
  status: AttendanceResultStatus;
  segments: PairedSegment[];
  checkInAbs: number | null;
  checkOutAbs: number | null;
  /** Tổng phút công thực */
  workedMinutes: number;
  workedHours: number;
  /** Số công chuẩn quy đổi (workedHours / standardDayHours) */
  standardDays: number;
  /** Phút trong khung giờ đêm của CA CHÍNH => phụ cấp 30% */
  nightMinutes: number;
  nightHours: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  absentMinutes: number;
  /** Giờ làm thêm theo loại ngày */
  otWeekdayMinutes: number;
  otWeekendMinutes: number;
  otHolidayMinutes: number;
  /** Giờ OT rơi vào khung đêm (được cộng thêm 30% + 20%) */
  otNightMinutes: number;
  /** Phút bù công từ đơn giải trình/công tác */
  regularizedMinutes: number;
  /** Cảnh báo để HR rà soát */
  warnings: string[];
  /** Quẹt bị loại vì ngoài cửa sổ */
  rejectedPunches: number[];
}

// ---------------------------------------------------------------------------
// TIỆN ÍCH NỘI BỘ
// ---------------------------------------------------------------------------

function inWindow(abs: number, lo: number, hi: number): boolean {
  return abs >= lo && abs <= hi;
}

/** Điểm giữa của một đoạn — ranh giới phân loại IN / OUT */
function segmentMidpoint(plannedIn: number, plannedOut: number): number {
  return (plannedIn + plannedOut) / 2;
}

function sourceOf(p: PunchLike | undefined): 'PUNCH' | 'REGULARIZATION' | 'INFERRED' | null {
  if (!p) return null;
  return p.isRegularization ? 'REGULARIZATION' : 'PUNCH';
}

// ---------------------------------------------------------------------------
// GHÉP CẶP THEO ĐOẠN (hỗ trợ ca gãy + ca đêm)
// ---------------------------------------------------------------------------

/**
 * Ghép cặp quẹt thẻ cho một ca đã resolve.
 *
 * @param shift     Ca kế hoạch đã resolve cho ngày công vụ
 * @param punches   Danh sách quẹt (absMinute so với 00:00 ngày workDate)
 * @param dayKind   Loại ngày theo lịch: ngày thường / nghỉ tuần / lễ
 * @param cfg       Cấu hình grace period, cửa sổ ghép cặp...
 */
export function pairPunches(
  shift: ResolvedShift,
  punches: readonly PunchLike[],
  dayKind: CalendarDayKind,
  cfg: Partial<PairingConfig> = {},
): AttendanceResult {
  const c: PairingConfig = { ...DEFAULT_PAIRING_CONFIG, ...cfg };
  const warnings: string[] = [];

  const sorted = [...punches].sort((a, b) => a.absMinute - b.absMinute);

  // --- 1. Lọc theo cửa sổ ghép cặp -----------------------------------------
  const winLo = shift.absStart - c.windowBeforeMin;
  const winHi = shift.absEnd + c.windowAfterMin;
  const inWin: PunchLike[] = [];
  const rejected: number[] = [];
  for (const p of sorted) {
    if (inWindow(p.absMinute, winLo, winHi)) inWin.push(p);
    else rejected.push(p.absMinute);
  }

  // --- 2. Ngày không làm việc theo lịch: mọi quẹt đều là OT -----------------
  if (dayKind === 'WEEKLY_REST' || dayKind === 'PUBLIC_HOLIDAY') {
    return buildRestDayResult(shift, inWin, rejected, dayKind, c, warnings);
  }

  // --- 3. Gán quẹt vào từng đoạn -------------------------------------------
  const buckets: PunchLike[][] = shift.segments.map(() => []);
  if (shift.segments.length === 1) {
    buckets[0]!.push(...inWin);
  } else {
    for (const p of inWin) {
      // Gán vào đoạn có điểm giữa gần quẹt nhất (nearest-midpoint)
      let bestIdx = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < shift.segments.length; i += 1) {
        const seg = shift.segments[i]!;
        const dist = Math.abs(p.absMinute - segmentMidpoint(seg.absStart, seg.absEnd));
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      buckets[bestIdx]!.push(p);
    }
  }

  // --- 4. Ghép FIRST-IN / LAST-OUT trong từng đoạn --------------------------
  const paired: PairedSegment[] = shift.segments.map((seg, i) => {
    const bucket = buckets[i]!;
    const ins: PunchLike[] = [];
    const outs: PunchLike[] = [];

    for (const p of bucket) {
      const mid = segmentMidpoint(seg.absStart, seg.absEnd);
      // Ưu tiên hướng do thiết bị khai báo; nếu không có thì suy theo midpoint
      const dir = p.direction ?? (p.absMinute < mid ? 'IN' : 'OUT');
      if (dir === 'IN') ins.push(p);
      else outs.push(p);
    }
    ins.sort((a, b) => a.absMinute - b.absMinute);
    outs.sort((a, b) => b.absMinute - a.absMinute); //降序 để lấy LAST-OUT

    const firstIn = ins[0] ?? null;
    const lastOut = outs[0] ?? null;

    let actualIn = firstIn?.absMinute ?? null;
    let actualOut = lastOut?.absMinute ?? null;
    let inSrc = sourceOf(firstIn ?? undefined);
    let outSrc = sourceOf(lastOut ?? undefined);

    // Sửa lỗi phổ biến: chỉ có quẹt OUT (quên quẹt vào) => suy giờ vào = giờ kế hoạch
    if (actualIn === null && actualOut !== null) {
      actualIn = seg.absStart;
      inSrc = 'INFERRED';
      warnings.push(`Đoạn "${seg.name}": thiếu quẹt VÀO — tạm lấy giờ kế hoạch ${seg.startClock}`);
    }
    // Chỉ có quẹt IN (quên quẹt ra) => suy giờ ra = giờ kế hoạch
    if (actualOut === null && actualIn !== null) {
      actualOut = seg.absEnd;
      outSrc = 'INFERRED';
      warnings.push(`Đoạn "${seg.name}": thiếu quẹt RA — tạm lấy giờ kế hoạch ${seg.endClock}`);
    }

    let workedMinutes = 0;
    if (actualIn !== null && actualOut !== null && actualOut > actualIn) {
      // Kẹp vào khoảng [kế hoạch vào, kế hoạch ra] để giờ đến sớm/về muộn
      // không bị tính lố vào giờ công chính (phần dư sẽ vào OT ở bước sau)
      const effIn = Math.max(actualIn, seg.absStart);
      const effOut = Math.min(actualOut, seg.absEnd);
      workedMinutes = Math.max(0, effOut - effIn - seg.breakMinutes);
    }

    const nightMinutes =
      actualIn !== null && actualOut !== null
        ? nightOverlapMinutes(
            Math.max(actualIn, seg.absStart),
            Math.min(actualOut, seg.absEnd),
            shift.nightStartMin,
            shift.nightEndMin,
          )
        : 0;

    return {
      index: i,
      name: seg.name,
      plannedIn: seg.absStart,
      plannedOut: seg.absEnd,
      actualIn,
      actualOut,
      workedMinutes,
      nightMinutes,
      missingIn: firstIn === null,
      missingOut: lastOut === null,
      inSource: inSrc,
      outSource: outSrc,
    };
  });

  // --- 5. Suy luận chéo đoạn: quên quẹt giữa ca gãy -------------------------
  // Nếu đoạn i thiếu OUT nhưng đoạn i+1 có IN => lấy IN của đoạn sau làm OUT.
  for (let i = 0; i < paired.length - 1; i += 1) {
    const cur = paired[i]!;
    const next = paired[i + 1]!;
    if (cur.missingOut && cur.actualIn !== null && next.actualIn !== null && next.actualIn > cur.plannedIn) {
      cur.actualOut = Math.min(next.actualIn, cur.plannedOut);
      cur.outSource = 'INFERRED';
      cur.missingOut = false;
      const effIn = Math.max(cur.actualIn, cur.plannedIn);
      const seg = shift.segments[i]!;
      cur.workedMinutes = Math.max(0, cur.actualOut - effIn - seg.breakMinutes);
      warnings.push(`Đoạn "${cur.name}": suy giờ RA từ quẹt vào của đoạn "${next.name}"`);
    }
  }

  // --- 6. Tổng hợp -----------------------------------------------------------
  const firstSeg = paired[0]!;
  const lastSeg = paired[paired.length - 1]!;
  const checkInAbs = firstSeg.actualIn;
  const checkOutAbs = lastSeg.actualOut;

  const workedMinutes = paired.reduce((acc, s) => acc + s.workedMinutes, 0);
  const nightMinutes = paired.reduce((acc, s) => acc + s.nightMinutes, 0);
  const regularizedMinutes = paired.reduce((acc, s) => {
    const inReg = s.inSource === 'REGULARIZATION';
    const outReg = s.outSource === 'REGULARIZATION';
    return acc + (inReg || outReg ? s.workedMinutes : 0);
  }, 0);

  // Đi trễ / về sớm (tính trên đoạn đầu và đoạn cuối)
  const rawLate = checkInAbs !== null ? checkInAbs - shift.absStart : 0;
  const lateMinutes = rawLate > c.graceMinutes ? Math.round(rawLate) : 0;
  if (rawLate > 0 && rawLate <= c.graceMinutes) {
    warnings.push(`Đi trễ ${Math.round(rawLate)}' — trong grace period ${c.graceMinutes}', không phạt`);
  }

  const rawEarly = checkOutAbs !== null ? shift.absEnd - checkOutAbs : 0;
  const earlyLeaveMinutes =
    rawEarly > c.earlyLeaveToleranceMin ? Math.round(Math.max(0, rawEarly)) : 0;

  // --- 7. Làm thêm giờ -------------------------------------------------------
  const ot = computeOvertime(shift, paired, checkOutAbs, dayKind, c, warnings);

  // --- 8. Xác định trạng thái -------------------------------------------------
  const status = resolveStatus({
    paired,
    checkInAbs,
    checkOutAbs,
    workedMinutes,
    plannedMinutes: shift.totalNetMinutes,
    lateMinutes,
    cfg: c,
  });

  const plannedMinutes = shift.totalNetMinutes;
  const absentMinutes =
    status === 'ABSENT' || status === 'WEEKLY_OFF' || status === 'HOLIDAY_OFF'
      ? 0
      : Math.max(0, plannedMinutes - workedMinutes);

  return {
    status,
    segments: paired,
    checkInAbs,
    checkOutAbs,
    workedMinutes,
    workedHours: workedMinutes / 60,
    standardDays: workedMinutes / 60 / c.standardDayHours,
    nightMinutes,
    nightHours: nightMinutes / 60,
    lateMinutes,
    earlyLeaveMinutes,
    absentMinutes,
    otWeekdayMinutes: ot.weekday,
    otWeekendMinutes: ot.weekend,
    otHolidayMinutes: ot.holiday,
    otNightMinutes: ot.night,
    regularizedMinutes,
    warnings,
    rejectedPunches: rejected,
  };
}

// ---------------------------------------------------------------------------
// TÍNH GIỜ LÀM THÊM (Điều 98 BLLĐ 2019)
// ---------------------------------------------------------------------------

interface OtResult {
  weekday: number;
  weekend: number;
  holiday: number;
  night: number;
}

/**
 * Giờ OT = phần thời gian LÀM THỰC TẾ nằm ngoài khoảng kế hoạch của ca.
 * Phân loại theo loại ngày lịch và tách riêng phần rơi vào khung giờ đêm.
 */
function computeOvertime(
  shift: ResolvedShift,
  paired: PairedSegment[],
  checkOutAbs: number | null,
  dayKind: CalendarDayKind,
  cfg: PairingConfig,
  warnings: string[],
): OtResult {
  const res: OtResult = { weekday: 0, weekend: 0, holiday: 0, night: 0 };

  // Khoảng thực tế đã làm (chỉ xét phần NGOÀI kế hoạch)
  const intervals: Array<[number, number]> = [];
  for (const s of paired) {
    if (s.actualIn === null || s.actualOut === null || s.actualOut <= s.actualIn) continue;
    // Phần trước giờ vào kế hoạch (đến sớm rồi làm luôn)
    if (s.actualIn < s.plannedIn) {
      const end = Math.min(s.actualOut, s.plannedIn);
      if (end > s.actualIn) intervals.push([s.actualIn, end]);
    }
    // Phần sau giờ ra kế hoạch (ở lại làm thêm)
    if (s.actualOut > s.plannedOut) {
      const start = Math.max(s.actualIn, s.plannedOut);
      if (s.actualOut > start) intervals.push([start, s.actualOut]);
    }
  }
  // Gộp các khoảng chồng lấn
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }

  let totalOt = 0;
  for (const [a, b] of merged) {
    const len = b - a;
    totalOt += len;
    res.night += nightOverlapMinutes(a, b, shift.nightStartMin, shift.nightEndMin);
    if (dayKind === 'PUBLIC_HOLIDAY') res.holiday += len;
    else if (dayKind === 'WEEKLY_REST') res.weekend += len;
    else res.weekday += len;
  }

  if (totalOt > 0) {
    const label =
      dayKind === 'PUBLIC_HOLIDAY' ? '300%' : dayKind === 'WEEKLY_REST' ? '200%' : '150%';
    warnings.push(`Phát sinh ${(totalOt / 60).toFixed(2)}h làm thêm (hệ số ${label})`);
  }
  if (checkOutAbs !== null && checkOutAbs > shift.absEnd && dayKind === 'WORKING_DAY') {
    const beyond = (checkOutAbs - shift.absEnd) / 60;
    if (beyond >= 4) {
      warnings.push(
        `OT ${(beyond).toFixed(2)}h ≥ 4h — kiểm tra giới hạn 40h/tháng (Điều 107 BLLĐ 2019)`,
      );
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// NGÀY NGHỈ THEO LỊCH: mọi giờ làm đều là OT
// ---------------------------------------------------------------------------

function buildRestDayResult(
  shift: ResolvedShift,
  inWin: readonly PunchLike[],
  rejected: number[],
  dayKind: CalendarDayKind,
  c: PairingConfig,
  warnings: string[],
): AttendanceResult {
  if (inWin.length === 0) {
    return {
      status: dayKind === 'WEEKLY_REST' ? 'WEEKLY_OFF' : 'HOLIDAY_OFF',
      segments: [],
      checkInAbs: null,
      checkOutAbs: null,
      workedMinutes: 0,
      workedHours: 0,
      standardDays: 0,
      nightMinutes: 0,
      nightHours: 0,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      absentMinutes: 0,
      otWeekdayMinutes: 0,
      otWeekendMinutes: 0,
      otHolidayMinutes: 0,
      otNightMinutes: 0,
      regularizedMinutes: 0,
      warnings,
      rejectedPunches: rejected,
    };
  }

  // Ghép FIRST-IN / LAST-OUT tự do trên toàn bộ quẹt trong ngày
  const ins = [...inWin].sort((a, b) => a.absMinute - b.absMinute);
  const firstIn = ins[0]!;
  const lastOut = ins[ins.length - 1]!;
  const worked = Math.max(0, lastOut.absMinute - firstIn.absMinute);
  const night = nightOverlapMinutes(
    firstIn.absMinute,
    lastOut.absMinute,
    shift.nightStartMin,
    shift.nightEndMin,
  );
  warnings.push(
    `Ngày ${dayKind === 'WEEKLY_REST' ? 'nghỉ hằng tuần' : 'lễ, tết'} có phát sinh công — toàn bộ tính OT`,
  );
  return {
    status: 'PRESENT',
    segments: [],
    checkInAbs: firstIn.absMinute,
    checkOutAbs: lastOut.absMinute,
    workedMinutes: worked,
    workedHours: worked / 60,
    standardDays: 0, // không tính công chính trong ngày nghỉ
    nightMinutes: 0,
    nightHours: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    absentMinutes: 0,
    otWeekdayMinutes: 0,
    otWeekendMinutes: dayKind === 'WEEKLY_REST' ? worked : 0,
    otHolidayMinutes: dayKind === 'PUBLIC_HOLIDAY' ? worked : 0,
    otNightMinutes: night,
    regularizedMinutes:
      firstIn.isRegularization || lastOut.isRegularization ? worked : 0,
    warnings,
    rejectedPunches: rejected,
  };
}

// ---------------------------------------------------------------------------
// XÁC ĐỊNH TRẠNG THÁI
// ---------------------------------------------------------------------------

function resolveStatus(args: {
  paired: PairedSegment[];
  checkInAbs: number | null;
  checkOutAbs: number | null;
  workedMinutes: number;
  plannedMinutes: number;
  lateMinutes: number;
  cfg: PairingConfig;
}): AttendanceResultStatus {
  const { paired, checkInAbs, checkOutAbs, workedMinutes, plannedMinutes, lateMinutes, cfg } = args;

  if (checkInAbs === null && checkOutAbs === null) return 'ABSENT';
  if (checkInAbs === null || checkOutAbs === null) return 'MISSING_PUNCH';

  const hasInferred = paired.some(
    (s) => s.inSource === 'INFERRED' || s.outSource === 'INFERRED',
  );
  if (hasInferred) return 'MISSING_PUNCH';

  if (lateMinutes >= cfg.absentAfterLateMin) return 'ABSENT';
  if (lateMinutes >= cfg.halfDayAfterLateMin) return 'HALF_DAY';

  // Thiếu quá 50% giờ công kế hoạch => nửa ngày
  if (plannedMinutes > 0 && workedMinutes < plannedMinutes * 0.5) return 'HALF_DAY';

  if (lateMinutes > 0) return 'LATE';
  return 'PRESENT';
}

// ---------------------------------------------------------------------------
// CHUYỂN ĐỔI GIỮA Date THẬT VÀ PHÚT TUYỆT ĐỐI
// ---------------------------------------------------------------------------

/**
 * Đổi một thời điểm quẹt (Date, giờ địa phương VN) thành phút tuyệt đối
 * so với 00:00 ngày công vụ `workDate`.
 *
 * Ví dụ: workDate = 2026-03-05, quẹt lúc 2026-03-06 06:00 => 1800.
 */
export function punchToAbsMinute(punchAt: Date | string, workDate: string, offsetHours = 7): number {
  const ts = new Date(punchAt).getTime();
  if (Number.isNaN(ts)) throw new Error(`Thời điểm quẹt không hợp lệ: ${String(punchAt)}`);
  const localTs = ts + offsetHours * 3_600_000;
  const base = new Date(`${workDate}T00:00:00.000Z`).getTime();
  return (localTs - base) / 60_000;
}

/** Ngược lại: phút tuyệt đối -> Date (UTC) */
export function absMinuteToDate(absMinute: number, workDate: string, offsetHours = 7): Date {
  const base = new Date(`${workDate}T00:00:00.000Z`).getTime();
  return new Date(base + absMinute * 60_000 - offsetHours * 3_600_000);
}

/** Số phút trong ngày của một ngày công vụ khác (dùng cho ca vắt nhiều ngày) */
export function dayOffsetMinutes(dayOffset: number): number {
  return dayOffset * MIN_PER_DAY;
}
