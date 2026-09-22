/**
 * Kiểm thử GIẢI CA, GHÉP CẶP QUẺT THẺ, CA ĐÊM VẮT 0h, CA GÃY, 3 CA 4 KÍP.
 */
import { describe, expect, it } from 'vitest';

import {
  nightOverlapMinutes,
  resolveRotationShiftCode,
  resolveShift,
  ROTATION_3CA_4KIP,
  type ShiftDef,
} from '../src/domain/shift-resolution.js';
import {
  absMinuteToDate,
  DEFAULT_PAIRING_CONFIG,
  pairPunches,
  punchToAbsMinute,
} from '../src/domain/punch-pairing.js';
import { MIN_PER_DAY, addDays, parseTimeOfDay } from '../src/domain/time.js';

// ---------------------------------------------------------------------------
// Định nghĩa ca mẫu
// ---------------------------------------------------------------------------

const OFFICE: ShiftDef = {
  code: 'HC',
  name: 'Hành chính',
  type: 'OFFICE',
  segments: [{ name: 'Sáng-chiều', start: '08:00', end: '17:00', breakMinutes: 60 }],
};

const NIGHT: ShiftDef = {
  code: 'CA3',
  name: 'Ca đêm',
  type: 'NIGHT_CROSS_DAY',
  segments: [{ name: 'Đêm', start: '22:00', end: '06:00', breakMinutes: 30 }],
};

const SPLIT: ShiftDef = {
  code: 'GAY',
  name: 'Ca gãy',
  type: 'SPLIT',
  segments: [
    { name: 'Sáng', start: '08:00', end: '12:00' },
    { name: 'Chiều', start: '14:00', end: '18:00' },
  ],
};

const THREE_SHIFT = {
  CA1: {
    code: 'CA1',
    name: 'Ca 1',
    type: 'ROTATING' as const,
    segments: [{ name: 'Sáng', start: '06:00', end: '14:00', breakMinutes: 30 }],
  },
  CA2: {
    code: 'CA2',
    name: 'Ca 2',
    type: 'ROTATING' as const,
    segments: [{ name: 'Chiều', start: '14:00', end: '22:00', breakMinutes: 30 }],
  },
  CA3: NIGHT,
};

describe('resolveShift — giải ca', () => {
  it('ca hành chính 08:00-17:00 trừ 60 phút nghỉ = 8h công', () => {
    const r = resolveShift(OFFICE, '2026-03-05');
    expect(r.absStart).toBe(8 * 60);
    expect(r.absEnd).toBe(17 * 60);
    expect(r.totalNetMinutes).toBe(9 * 60 - 60);
    expect(r.standardDays).toBe(1);
    expect(r.crossMidnight).toBe(false);
    expect(r.nightMinutes).toBe(0);
  });

  it('CA ĐÊM 22:00 → 06:00(+1): absEnd = 1800, crossMidnight = true', () => {
    const r = resolveShift(NIGHT, '2026-03-05');
    expect(r.absStart).toBe(22 * 60); // 1320
    expect(r.absEnd).toBe(MIN_PER_DAY + 6 * 60); // 1800
    expect(r.crossMidnight).toBe(true);
    expect(r.endDate).toBe('2026-03-06');
    // Tổng thời lượng 8h, trừ 30' nghỉ = 450'
    expect(r.totalNetMinutes).toBe(8 * 60 - 30);
    // Toàn bộ ca nằm trong khung đêm 22:00–06:00 => 480 phút
    expect(r.nightMinutes).toBe(480);
  });

  it('ca gãy có 2 đoạn độc lập', () => {
    const r = resolveShift(SPLIT, '2026-03-05');
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]!.absStart).toBe(480);
    expect(r.segments[0]!.absEnd).toBe(720);
    expect(r.segments[1]!.absStart).toBe(840);
    expect(r.segments[1]!.absEnd).toBe(1080);
    expect(r.totalNetMinutes).toBe(480);
  });

  it('phát hiện đoạn chồng lấn', () => {
    expect(() =>
      resolveShift(
        {
          code: 'BAD',
          name: 'Sai',
          type: 'SPLIT',
          segments: [
            { name: 'A', start: '08:00', end: '13:00' },
            { name: 'B', start: '12:00', end: '17:00' },
          ],
        },
        '2026-03-05',
      ),
    ).toThrow(/chồng lấn/);
  });

  it('parseTimeOfDay chấp nhận 24:00 và bắt lỗi định dạng', () => {
    expect(parseTimeOfDay('24:00')).toBe(1440);
    expect(parseTimeOfDay('0:05')).toBe(5);
    expect(() => parseTimeOfDay('25:00')).toThrow();
    expect(() => parseTimeOfDay('abc')).toThrow();
  });
});

describe('nightOverlapMinutes — khung giờ đêm pháp lý 22:00–06:00', () => {
  it('toàn bộ ca đêm = 480 phút', () => {
    expect(nightOverlapMinutes(1320, 1800)).toBe(480);
  });
  it('ca hành chính không có phút đêm', () => {
    expect(nightOverlapMinutes(480, 1020)).toBe(0);
  });
  it('ca chiều 14:00–23:00 chỉ có 60 phút đêm (22:00–23:00)', () => {
    expect(nightOverlapMinutes(14 * 60, 23 * 60)).toBe(60);
  });
  it('ca sáng 05:00–13:00 có 60 phút đêm (05:00–06:00)', () => {
    expect(nightOverlapMinutes(5 * 60, 13 * 60)).toBe(60);
  });
  it('khoảng 0 giờ = 0 phút', () => {
    expect(nightOverlapMinutes(500, 500)).toBe(0);
    expect(nightOverlapMinutes(600, 500)).toBe(0);
  });
});

describe('pairPunches — ca hành chính', () => {
  const shift = resolveShift(OFFICE, '2026-03-05');

  it('đúng giờ: PRESENT, đủ 8h công', () => {
    const r = pairPunches(
      shift,
      [
        { absMinute: 7 * 60 + 50 },
        { absMinute: 17 * 60 + 10 },
      ],
      'WORKING_DAY',
    );
    expect(r.status).toBe('PRESENT');
    expect(r.workedMinutes).toBe(480);
    expect(r.standardDays).toBe(1);
    expect(r.lateMinutes).toBe(0);
  });

  it('GRACE PERIOD: trễ 8 phút (ngưỡng 10) không phạt', () => {
    const r = pairPunches(
      shift,
      [
        { absMinute: 8 * 60 + 8 },
        { absMinute: 17 * 60 },
      ],
      'WORKING_DAY',
      { graceMinutes: 10 },
    );
    expect(r.lateMinutes).toBe(0);
    expect(r.status).toBe('PRESENT');
    expect(r.warnings.some((w) => w.includes('grace period'))).toBe(true);
  });

  it('trễ 25 phút vượt grace → LATE', () => {
    const r = pairPunches(
      shift,
      [
        { absMinute: 8 * 60 + 25 },
        { absMinute: 17 * 60 },
      ],
      'WORKING_DAY',
      { graceMinutes: 10 },
    );
    expect(r.lateMinutes).toBe(25);
    expect(r.status).toBe('LATE');
  });

  it('trễ 150 phút → HALF_DAY (ngưỡng 120)', () => {
    const r = pairPunches(
      shift,
      [
        { absMinute: 8 * 60 + 150 },
        { absMinute: 17 * 60 },
      ],
      'WORKING_DAY',
    );
    expect(r.status).toBe('HALF_DAY');
  });

  it('không có quẹt nào → ABSENT', () => {
    const r = pairPunches(shift, [], 'WORKING_DAY');
    expect(r.status).toBe('ABSENT');
    expect(r.workedMinutes).toBe(0);
  });

  it('thiếu quẹt RA → MISSING_PUNCH và suy giờ ra theo kế hoạch', () => {
    const r = pairPunches(shift, [{ absMinute: 8 * 60 }], 'WORKING_DAY');
    expect(r.status).toBe('MISSING_PUNCH');
    expect(r.segments[0]!.missingOut).toBe(true);
    expect(r.segments[0]!.outSource).toBe('INFERRED');
    expect(r.workedMinutes).toBe(480);
  });

  it('làm thêm 2h sau giờ ra → OT ngày thường 120 phút', () => {
    const r = pairPunches(
      shift,
      [
        { absMinute: 8 * 60 },
        { absMinute: 19 * 60 },
      ],
      'WORKING_DAY',
    );
    expect(r.workedMinutes).toBe(480); // giờ công chính không đổi
    expect(r.otWeekdayMinutes).toBe(120);
    expect(r.otWeekendMinutes).toBe(0);
  });

  it('quẹt ngoài cửa sổ bị loại', () => {
    const r = pairPunches(
      shift,
      [
        { absMinute: 2 * 60 }, // 02:00 — quá sớm
        { absMinute: 8 * 60 },
        { absMinute: 17 * 60 },
        { absMinute: 23 * 60 + 30 }, // 23:30 — quá muộn
      ],
      'WORKING_DAY',
    );
    expect(r.rejectedPunches).toContain(120);
    expect(r.workedMinutes).toBe(480);
  });
});

describe('pairPunches — CA ĐÊM VẮT 0h', () => {
  const shift = resolveShift(NIGHT, '2026-03-05');

  it('quẹt 22:00 ngày 05/03 và 06:00 ngày 06/03 → đủ 450 phút, 480 phút đêm', () => {
    const workDate = '2026-03-05';
    const inPunch = punchToAbsMinute(new Date('2026-03-05T22:00:00+07:00'), workDate);
    const outPunch = punchToAbsMinute(new Date('2026-03-06T06:00:00+07:00'), workDate);
    expect(inPunch).toBe(1320);
    expect(outPunch).toBe(1800); // qua ngày => +1440

    const r = pairPunches(shift, [{ absMinute: inPunch }, { absMinute: outPunch }], 'WORKING_DAY');
    expect(r.status).toBe('PRESENT');
    expect(r.workedMinutes).toBe(480 - 30); // 8h trừ 30' nghỉ
    expect(r.nightMinutes).toBe(480);
    expect(r.nightHours).toBe(8);
  });

  it('đổi phút tuyệt đối ngược lại ra đúng Date', () => {
    const d = absMinuteToDate(1800, '2026-03-05');
    expect(d.toISOString()).toBe('2026-03-05T23:00:00.000Z'); // = 06:00 +07 ngày 06/03
  });

  it('về sớm 1h trong ca đêm → thiếu 60 phút công', () => {
    const r = pairPunches(
      shift,
      [{ absMinute: 1320 }, { absMinute: 1740 }], // ra lúc 05:00
      'WORKING_DAY',
    );
    expect(r.earlyLeaveMinutes).toBe(60);
    expect(r.workedMinutes).toBe(420 - 30);
  });
});

describe('pairPunches — CA GÃY (split shift)', () => {
  const shift = resolveShift(SPLIT, '2026-03-05');

  it('4 quẹt → ghép đúng 2 đoạn, 8h công', () => {
    const r = pairPunches(
      shift,
      [
        { absMinute: 7 * 60 + 55 },
        { absMinute: 12 * 60 + 5 },
        { absMinute: 13 * 60 + 55 },
        { absMinute: 18 * 60 + 5 },
      ],
      'WORKING_DAY',
    );
    expect(r.segments).toHaveLength(2);
    expect(r.workedMinutes).toBe(480);
    expect(r.status).toBe('PRESENT');
    expect(r.checkInAbs).toBe(7 * 60 + 55);
    expect(r.checkOutAbs).toBe(18 * 60 + 5);
  });

  it('quên quẹt giữa ca → suy giờ RA đoạn sáng từ quẹt VÀO đoạn chiều', () => {
    const r = pairPunches(
      shift,
      [
        { absMinute: 8 * 60 },
        // thiếu quẹt ra đoạn sáng
        { absMinute: 14 * 60 },
        { absMinute: 18 * 60 },
      ],
      'WORKING_DAY',
    );
    expect(r.segments[0]!.outSource).toBe('INFERRED');
    expect(r.warnings.some((w) => w.includes('suy giờ RA'))).toBe(true);
    expect(r.workedMinutes).toBe(480);
  });
});

describe('pairPunches — ngày nghỉ theo lịch: mọi giờ là OT', () => {
  const shift = resolveShift(OFFICE, '2026-03-08'); // Chủ nhật

  it('nghỉ hằng tuần có làm 4h → OT 200%, không tính công chính', () => {
    const r = pairPunches(
      shift,
      [
        { absMinute: 8 * 60 },
        { absMinute: 12 * 60 },
      ],
      'WEEKLY_REST',
    );
    expect(r.status).toBe('PRESENT');
    expect(r.otWeekendMinutes).toBe(240);
    expect(r.otWeekdayMinutes).toBe(0);
    expect(r.standardDays).toBe(0);
  });

  it('ngày lễ có làm → OT 300%', () => {
    const r = pairPunches(
      shift,
      [
        { absMinute: 8 * 60 },
        { absMinute: 11 * 60 },
      ],
      'PUBLIC_HOLIDAY',
    );
    expect(r.otHolidayMinutes).toBe(180);
  });

  it('nghỉ hằng tuần không quẹt → WEEKLY_OFF', () => {
    const r = pairPunches(shift, [], 'WEEKLY_REST');
    expect(r.status).toBe('WEEKLY_OFF');
  });
});

describe('pairPunches — bù công từ đơn giải trình', () => {
  const shift = resolveShift(OFFICE, '2026-03-05');

  it('quẹt giải trình thay thế quẹt thiếu và được ghi nhận regularizedMinutes', () => {
    const r = pairPunches(
      shift,
      [
        { absMinute: 8 * 60 },
        { absMinute: 17 * 60, isRegularization: true, source: 'REGULARIZATION' },
      ],
      'WORKING_DAY',
    );
    expect(r.regularizedMinutes).toBe(480);
    expect(r.workedMinutes).toBe(480);
  });
});

describe('resolveRotationShiftCode — hệ 3 ca 4 kíp', () => {
  const anchor = '2026-03-01';

  it('kíp A ngày neo bắt đầu bằng CA1', () => {
    expect(resolveRotationShiftCode('2026-03-01', anchor, 0)).toBe('CA1');
  });

  it('chu kỳ 8 ngày: 2 sáng, 2 chiều, 2 đêm, 2 nghỉ', () => {
    const codes = Array.from({ length: 8 }, (_, i) =>
      resolveRotationShiftCode(addDays(anchor, i), anchor, 0),
    );
    expect(codes).toEqual(['CA1', 'CA1', 'CA2', 'CA2', 'CA3', 'CA3', null, null]);
  });

  it('4 kíp lệch pha nhau 2 ngày — tại cùng 1 ngày có đủ 3 ca + 1 kíp nghỉ', () => {
    const day = '2026-03-03';
    const codes = [0, 1, 2, 3].map((t) => resolveRotationShiftCode(day, anchor, t));
    // Mỗi ngày luôn có đúng 3 kíp đi làm (1 kíp nghỉ) và 3 ca khác nhau
    const working = codes.filter((c) => c !== null);
    expect(working).toHaveLength(3);
    expect(new Set(working).size).toBe(3);
  });

  it('mẫu xoay khớp hằng số đã khai báo', () => {
    expect(ROTATION_3CA_4KIP.cycleLength).toBe(8);
    expect(THREE_SHIFT.CA3.segments[0]!.end).toBe('06:00');
  });

  it('ngày trước ngày neo vẫn tính đúng (index không âm)', () => {
    const before = addDays(anchor, -1);
    const code = resolveRotationShiftCode(before, anchor, 0);
    expect(['CA1', 'CA2', 'CA3', null]).toContain(code);
    expect(code).toBe(null); // ngày -1 trong chu kỳ 8 là REST
  });

  it('bắt lỗi teamIndex âm', () => {
    expect(() => resolveRotationShiftCode(anchor, anchor, -1)).toThrow();
  });
});

describe('Cấu hình ghép cặp mặc định', () => {
  it('có giá trị hợp lý cho sản xuất', () => {
    expect(DEFAULT_PAIRING_CONFIG.graceMinutes).toBe(10);
    expect(DEFAULT_PAIRING_CONFIG.standardDayHours).toBe(8);
    expect(DEFAULT_PAIRING_CONFIG.windowBeforeMin).toBeGreaterThan(0);
  });
});
