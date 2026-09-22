/**
 * Kiểm thử ĐỘNG CƠ TÍNH LƯƠNG — các kịch bản có kiểm tra bằng tay độc lập.
 */
import { describe, expect, it } from 'vitest';

import { calculatePayroll, calculatePayrollBatch, normalizeAttendance, DEFAULT_PAYROLL_CONFIG } from '../src/domain/payroll.js';
import { REGIME_LEGACY_7B, REGIME_VN_2026_5B, resolveTaxRegime } from '../src/config/tax-regime.js';
import { buildPolicySnapshot } from '../src/config/insurance.js';

const baseAttendance = {
  workedDays: 26,
  scheduledDays: 26,
  paidLeaveDays: 0,
  unpaidLeaveDays: 0,
  nightHours: 0,
  otWeekdayHours: 0,
  otWeekendHours: 0,
  otHolidayHours: 0,
  lateCount: 0,
  lateMinutes: 0,
  earlyLeaveCount: 0,
  missingPunchCount: 0,
  absentDays: 0,
};

function makeEmp(over: Record<string, any> = {}) {
  return {
    employeeId: 'emp-1',
    employeeCode: 'NV001',
    fullName: 'Trần Minh Tuấn',
    costAccount: '6422',
    contract: {
      baseSalary: 25_000_000,
      contractSalary: 30_000_000,
      maxKpiSalary: 0,
    },
    insurance: { wageRegion: 'I' as const },
    attendance: { ...baseAttendance },
    dependents: 2,
    ...over,
  } as any;
}

describe('Payroll Engine — kịch bản chuẩn 2025 (biểu 7 bậc, giảm trừ 11tr/4.4tr)', () => {
  const cfg = { periodEnd: '2025-06-30', taxRegime: 'LEGACY_7B' };

  it('tính đúng BHXH 10.5% và 21.5% trên lương hợp đồng 30tr (dưới trần 46.8tr)', () => {
    const r = calculatePayroll(makeEmp(), cfg);
    // 30.000.000 × 8% = 2.400.000 ; ×1.5% = 450.000 ; ×1% = 300.000
    expect(r.insurance.employee.si).toBe(2_400_000);
    expect(r.insurance.employee.hi).toBe(450_000);
    expect(r.insurance.employee.ui).toBe(300_000);
    expect(r.totalInsuranceEmployee).toBe(3_150_000);
    // NSDLĐ: 17% + 3% + 1% + 0.5% = 21.5% → 6.450.000
    expect(r.insurance.employer.si).toBe(5_100_000);
    expect(r.insurance.employer.hi).toBe(900_000);
    expect(r.insurance.employer.ui).toBe(300_000);
    expect(r.insurance.employer.wci).toBe(150_000);
    expect(r.totalInsuranceEmployer).toBe(6_450_000);
    expect(r.insurance.siCapHit).toBe(false);
  });

  it('tính đúng thuế TNCN 7 bậc với 2 người phụ thuộc', () => {
    const r = calculatePayroll(makeEmp(), cfg);
    // Gross = lương CƠ BẢN 25.000.000 (không phải lương hợp đồng 30tr)
    //       + phụ cấp ăn trưa 30.000đ × 26 ngày = 780.000
    expect(r.gross).toBe(25_000_000 + 30_000 * 26); // 25.780.000
    // Thu nhập chịu thuế = gross − phần ăn trưa miễn thuế (730.000)
    expect(r.assessableIncome).toBe(r.gross - 730_000);
    // Giảm trừ: 3.150.000 + 11.000.000 + 2×4.400.000 = 22.950.000
    expect(r.pit.deductions.total).toBe(3_150_000 + 11_000_000 + 8_800_000);
    const taxable = r.assessableIncome - 22_950_000;
    expect(r.pit.taxableIncome).toBe(taxable);
    // assessable = 25.780.000 − 730.000 (ăn trưa miễn thuế) = 25.050.000
    // taxable    = 25.050.000 − 22.950.000 = 2.100.000  → chỉ rơi vào bậc 1 (5%)
    expect(taxable).toBe(2_100_000);
    expect(r.pit.tax).toBe(Math.round(2_100_000 * 0.05)); // 105.000
    expect(r.pit.brackets).toHaveLength(1);
    expect(r.pit.brackets[0]!.level).toBe(1);
    expect(r.pit.quickFormulaMatch).toBe(true);
    expect(r.pit.regimeCode).toBe('LEGACY_7B');
  });

  it('thực lĩnh = gross − 10.5% − TNCN', () => {
    const r = calculatePayroll(makeEmp(), cfg);
    expect(r.net).toBe(r.gross - r.totalInsuranceEmployee - r.pitAmount - r.totalDeductions);
    expect(r.carryForward).toBe(0);
  });

  it('tổng chi phí doanh nghiệp = gross + 21.5%', () => {
    const r = calculatePayroll(makeEmp(), cfg);
    expect(r.totalCostToCompany).toBe(r.gross + 6_450_000);
  });
});

describe('Payroll Engine — áp trần BHXH/BHYT và BHTN (HAI TRẦN KHÁC NHAU)', () => {
  it('lương 60tr vùng I từ 01/07/2026: BHXH áp trần 50.6tr, BHTN KHÔNG áp trần', () => {
    const r = calculatePayroll(
      makeEmp({ contract: { baseSalary: 60_000_000, contractSalary: 60_000_000 } }),
      { periodEnd: '2026-07-31', taxRegime: 'AUTO' },
    );
    const snap = buildPolicySnapshot('2026-07-31');
    expect(snap.referenceSalary).toBe(2_530_000);
    expect(snap.siCap).toBe(50_600_000);
    expect(snap.uiCapByRegion.I).toBe(106_200_000);

    expect(r.siBase).toBe(50_600_000); // bị chặn ở trần BHXH
    expect(r.uiBase).toBe(60_000_000); // KHÔNG bị chặn (trần BHTN 106.2tr)
    expect(r.insurance.siCapHit).toBe(true);
    expect(r.insurance.uiCapHit).toBe(false);

    // BHXH 8% × 50.600.000 = 4.048.000 ; BHYT 1.5% = 759.000 ; BHTN 1% × 60tr = 600.000
    expect(r.insurance.employee.si).toBe(4_048_000);
    expect(r.insurance.employee.hi).toBe(759_000);
    expect(r.insurance.employee.ui).toBe(600_000);
    expect(r.totalInsuranceEmployee).toBe(4_048_000 + 759_000 + 600_000);
  });

  it('trước 01/07/2026 trần BHXH là 46.8tr (mức tham chiếu 2.34tr)', () => {
    const r = calculatePayroll(
      makeEmp({ contract: { baseSalary: 60_000_000, contractSalary: 60_000_000 } }),
      { periodEnd: '2026-03-31', taxRegime: 'AUTO' },
    );
    expect(r.siBase).toBe(46_800_000);
    expect(r.insurance.siCapApplied).toBe(46_800_000);
  });

  it('sàn BHXH = mức tham chiếu 2.340.000, sàn BHTN = LTTV vùng I 4.960.000 (HAI SÀN KHÁC NHAU)', () => {
    const r = calculatePayroll(
      makeEmp({ contract: { baseSalary: 2_000_000, contractSalary: 2_000_000 } }),
      { periodEnd: '2025-06-30', taxRegime: 'LEGACY_7B' },
    );
    // BHXH/BHYT: sàn là mức tham chiếu (điểm đ khoản 1 Điều 31 Luật BHXH 2024)
    expect(r.siBase).toBe(2_340_000);
    // BHTN: sàn là LTTV vùng I 2025 = 4.960.000 (NĐ 74/2024)
    expect(r.uiBase).toBe(4_960_000);
    expect(r.insurance.floorApplied).toBe(true);
    // Khớp từng loại: 8% + 1.5% trên 2.340.000, 1% trên 4.960.000
    expect(r.insurance.employee.si).toBe(Math.round(2_340_000 * 0.08));
    expect(r.insurance.employee.hi).toBe(Math.round(2_340_000 * 0.015));
    expect(r.insurance.employee.ui).toBe(Math.round(4_960_000 * 0.01));
  });

  it('trần BHTN theo vùng II/III/IV đúng NĐ 293/2025', () => {
    const bigSalary = { baseSalary: 200_000_000, contractSalary: 200_000_000 };
    for (const [region, cap] of [
      ['I', 106_200_000],
      ['II', 94_600_000],
      ['III', 82_800_000],
      ['IV', 74_000_000],
    ] as const) {
      const r = calculatePayroll(
        makeEmp({ contract: bigSalary, insurance: { wageRegion: region } }),
        { periodEnd: '2026-07-31', taxRegime: 'AUTO' },
      );
      expect(r.insurance.uiCapApplied, `vùng ${region}`).toBe(cap);
      expect(r.uiBase, `vùng ${region}`).toBe(cap);
      expect(r.insurance.uiCapHit, `vùng ${region}`).toBe(true);
    }
  });
});

describe('Payroll Engine — biểu thuế 5 bậc 2026 và giảm trừ mới', () => {
  it('giảm trừ bản thân 15.5tr, NPT 6.2tr, biểu 5 bậc', () => {
    const r = calculatePayroll(makeEmp(), { periodEnd: '2026-09-30', taxRegime: 'AUTO' });
    expect(r.pit.regimeCode).toBe('VN_2026_5B');
    expect(r.pit.deductions.self).toBe(15_500_000);
    expect(r.pit.deductions.perDependent).toBe(6_200_000);
    expect(r.pit.deductions.dependents).toBe(12_400_000);
    // taxable = 30.780.000 − (3.150.000 + 15.500.000 + 12.400.000) = 0 → không phải nộp
    // (30.780.000 − 31.050.000 < 0)
    expect(r.pit.taxableIncome).toBe(0);
    expect(r.pit.tax).toBe(0);
    expect(r.net).toBe(r.gross - r.totalInsuranceEmployee);
  });

  it('kiểm tra chéo 5 bậc bằng tay với thu nhập tính thuế 35.000.000', () => {
    const r = calculatePayroll(
      makeEmp({
        contract: { baseSalary: 50_000_000, contractSalary: 50_000_000 },
        dependents: 0,
        attendance: { ...baseAttendance, workedDays: 0, scheduledDays: 0 },
      }),
      { periodEnd: '2026-09-30', taxRegime: 'VN_2026_5B', standardWorkDays: 26 },
    );
    // Không có ngày công kế hoạch → prorateRatio = 1 (scheduledDays = 0)
    // gross = 50.000.000 ; BHXH trên 50tr: si cap 50.6tr → không áp trần
    //   8% = 4.000.000 ; 1.5% = 750.000 ; 1% = 500.000 → 5.250.000
    expect(r.totalInsuranceEmployee).toBe(5_250_000);
    // taxable = 50.000.000 − 5.250.000 − 15.500.000 = 29.250.000
    expect(r.pit.taxableIncome).toBe(29_250_000);
    // 5 bậc: 10.000.000×5% = 500.000 ; 19.250.000×10% = 1.925.000 → 2.425.000
    expect(r.pit.tax).toBe(2_425_000);
    // công thức rút gọn bậc 2: 29.250.000×10% − 500.000 = 2.425.000
    expect(r.pit.quickFormulaTax).toBe(2_425_000);
  });

  it('resolveTaxRegime chọn đúng chế độ theo mốc hiệu lực', () => {
    expect(resolveTaxRegime('2025-12-31').code).toBe('LEGACY_7B');
    expect(resolveTaxRegime('2026-01-01').code).toBe('BRIDGE_2026H1');
    expect(resolveTaxRegime('2026-06-30').code).toBe('BRIDGE_2026H1');
    expect(resolveTaxRegime('2026-07-01').code).toBe('VN_2026_5B');
    expect(resolveTaxRegime('2030-01-01').code).toBe('VN_2026_5B');
    expect(resolveTaxRegime('2026-09-30', 'LEGACY_7B').code).toBe('LEGACY_7B');
    expect(() => resolveTaxRegime('2026-09-30', 'KHONG_TON_TAI')).toThrow();
  });
});

describe('Payroll Engine — làm thêm giờ và phụ cấp đêm', () => {
  const cfg = { periodEnd: '2025-06-30', taxRegime: 'LEGACY_7B' };

  it('OT ngày thường 150%: 4 giờ, lương giờ = 25tr/26/8 = 120.192đ', () => {
    const r = calculatePayroll(
      makeEmp({ attendance: { ...baseAttendance, otWeekdayHours: 4 } }),
      cfg,
    );
    expect(r.hourlyRate).toBe(Math.round(25_000_000 / 26 / 8)); // 120192
    const ot = r.earnings.find((e) => e.code === 'OT_WEEKDAY')!;
    expect(ot).toBeDefined();
    expect(ot.amount).toBe(r.hourlyRate * 1.5 * 4);
    // Phần bằng lương thường chịu thuế, phần vượt (50%) miễn
    expect(ot.taxableAmount).toBe(Math.round(r.hourlyRate * 1 * 4));
    expect(ot.exemptAmount).toBe(Math.round(r.hourlyRate * 0.5 * 4));
  });

  it('OT ngày nghỉ tuần 200% và ngày lễ 300%', () => {
    const r = calculatePayroll(
      makeEmp({ attendance: { ...baseAttendance, otWeekendHours: 8, otHolidayHours: 8 } }),
      cfg,
    );
    expect(r.earnings.find((e) => e.code === 'OT_WEEKEND')!.amount).toBe(Math.round(r.hourlyRate * 2 * 8));
    expect(r.earnings.find((e) => e.code === 'OT_HOLIDAY')!.amount).toBe(Math.round(r.hourlyRate * 3 * 8));
  });

  it('phụ cấp làm đêm 30% được miễn thuế toàn bộ', () => {
    const r = calculatePayroll(
      makeEmp({ attendance: { ...baseAttendance, nightHours: 64 } }),
      cfg,
    );
    const night = r.earnings.find((e) => e.code === 'NIGHT_ALLOWANCE')!;
    expect(night.amount).toBe(Math.round(r.hourlyRate * 0.3 * 64));
    expect(night.taxableAmount).toBe(0);
    expect(night.exemptAmount).toBe(night.amount);
    expect(night.taxTreatment).toBe('EXEMPT');
  });

  it('bộ tách miễn thuế độc lập khớp với engine', () => {
    const r = calculatePayroll(
      makeEmp({
        attendance: {
          ...baseAttendance,
          otWeekdayHours: 6,
          otWeekendHours: 4,
          otHolidayHours: 2,
          nightHours: 40,
        },
      }),
      cfg,
    );
    const inlineTotal = r.earnings
      .filter((e) => ['OT_WEEKDAY', 'OT_WEEKEND', 'OT_HOLIDAY', 'NIGHT_ALLOWANCE'].includes(e.code))
      .reduce((a, b) => a + b.amount, 0);
    expect(Math.abs(inlineTotal - r.otDetail!.totalPaid)).toBeLessThanOrEqual(3);
    expect(r.warnings.filter((w) => w.includes('Chênh lệch OT'))).toHaveLength(0);
  });
});

describe('Payroll Engine — công thức lương động (Formula Builder)', () => {
  const cfg = { periodEnd: '2025-06-30', taxRegime: 'LEGACY_7B' };

  it('tính phụ cấp trách nhiệm = 10% lương cơ bản qua formula', () => {
    const r = calculatePayroll(
      makeEmp({
        customComponents: [
          {
            code: 'RESPONSIBILITY',
            name: 'Phụ cấp trách nhiệm',
            type: 'EARNING',
            formula: 'round(baseSalary * 0.1)',
          },
        ],
      }),
      cfg,
    );
    const line = r.earnings.find((e) => e.code === 'RESPONSIBILITY')!;
    expect(line.amount).toBe(2_500_000);
    expect(r.audit.customComponentsApplied).toContain('RESPONSIBILITY=2500000');
  });

  it('phạt theo điều kiện ba ngôi trong formula', () => {
    const r = calculatePayroll(
      makeEmp({
        attendance: { ...baseAttendance, lateMinutes: 45, lateCount: 3 },
        customComponents: [
          {
            code: 'CUSTOM_LATE',
            name: 'Phạt trễ tuỳ chỉnh',
            type: 'DEDUCTION',
            formula: 'lateMinutes > 30 ? lateCount * 100000 : 0',
          },
        ],
        // tắt phạt hệ thống để kiểm tra riêng phần custom
      }),
      { ...cfg, penalty: { ...DEFAULT_PAYROLL_CONFIG.penalty, latePerMinuteFactor: 0 } },
    );
    expect(r.deductionItems.find((d) => d.code === 'CUSTOM_LATE')!.amount).toBe(300_000);
  });

  it('hoa hồng luỹ tiến bằng hàm tier()', () => {
    const r = calculatePayroll(
      makeEmp({
        commissionRevenue: 1_500_000_000,
        customComponents: [
          {
            code: 'TIERED_COMM',
            name: 'Hoa hồng bậc thang',
            type: 'EARNING',
            // 3% cho 500tr đầu, 5% cho phần 500tr–1 tỷ, 7% phần trên 1 tỷ
            formula: 'tier(commissionRevenue, 500000000, 0.03, 1000000000, 0.05, 999999999999, 0.07)',
          },
        ],
      }),
      cfg,
    );
    const line = r.earnings.find((e) => e.code === 'TIERED_COMM')!;
    // 500tr×3% = 15tr ; 500tr×5% = 25tr ; 500tr×7% = 35tr → 75tr
    expect(line.amount).toBe(75_000_000);
  });
});

describe('Payroll Engine — khấu trừ và các trường hợp biên', () => {
  const cfg = { periodEnd: '2025-06-30', taxRegime: 'LEGACY_7B' };

  it('nghỉ không lương 26/26 ngày: lương = 0, không đóng BHXH', () => {
    const r = calculatePayroll(
      makeEmp({
        attendance: { ...baseAttendance, workedDays: 0, unpaidLeaveDays: 26 },
      }),
      { ...cfg, siBaseMode: 'AUTO' },
    );
    expect(r.prorateRatio).toBe(0);
    expect(r.earnings.find((e) => e.code === 'BASE')?.amount ?? 0).toBe(0);
    expect(r.totalInsuranceEmployee).toBe(0);
    expect(r.pitAmount).toBe(0);
    expect(r.net).toBe(0);
    expect(r.audit.siBaseModeResolved).toBe('PRORATED');
  });

  it('thực lĩnh không âm — phần dư chuyển kỳ sau', () => {
    const r = calculatePayroll(
      makeEmp({
        attendance: { ...baseAttendance, workedDays: 3, unpaidLeaveDays: 23 },
        advance: 20_000_000,
      }),
      cfg,
    );
    expect(r.net).toBe(0);
    expect(r.carryForward).toBeGreaterThan(0);
  });

  it('thử việc 85% lương cơ bản', () => {
    const r = calculatePayroll(
      makeEmp({
        contract: {
          baseSalary: 20_000_000,
          contractSalary: 20_000_000,
          probationRate: 0.85,
          isProbation: true,
        },
      }),
      cfg,
    );
    expect(r.earnings.find((e) => e.code === 'BASE')!.amount).toBe(17_000_000);
    expect(r.warnings.some((w) => w.includes('thử việc'))).toBe(true);
  });

  it('KPI tính theo điểm và tỷ lệ ngày công', () => {
    const r = calculatePayroll(
      makeEmp({
        contract: { baseSalary: 25_000_000, contractSalary: 30_000_000, maxKpiSalary: 5_000_000 },
        kpiScore: 80,
        attendance: { ...baseAttendance, workedDays: 13, scheduledDays: 26 },
      }),
      cfg,
    );
    expect(r.prorateRatio).toBe(0.5);
    expect(r.earnings.find((e) => e.code === 'BASE')!.amount).toBe(12_500_000);
    expect(r.earnings.find((e) => e.code === 'KPI')!.amount).toBe(2_000_000); // 5tr × 80% × 0.5
  });

  it('báo lỗi khi lương cơ bản <= 0', () => {
    expect(() =>
      calculatePayroll(makeEmp({ contract: { baseSalary: 0, contractSalary: 10_000_000 } }), cfg),
    ).toThrow(/Lương cơ bản/);
  });

  it('tính hàng loạt: lỗi một nhân viên không làm hỏng cả bảng', () => {
    const { results, errors } = calculatePayrollBatch(
      [
        makeEmp(),
        makeEmp({ employeeCode: 'BAD', contract: { baseSalary: -1, contractSalary: 1 } }),
        makeEmp({ employeeCode: 'NV003' }),
      ],
      cfg,
    );
    expect(results).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.employeeCode).toBe('BAD');
  });
});

// =============================================================================
// HỒI QUY: thiếu trường chấm công KHÔNG được âm thầm trả về lương 0đ
// =============================================================================
// Bug từng có: `Math.max(0, a.paidLeaveDays)` với paidLeaveDays = undefined
// cho ra NaN → prorateRatio = NaN → roundVnd(baseSalary * NaN) = 0.
// Cả bảng lương thành 0đ mà không một dòng log nào báo.
// =============================================================================

describe('Payroll Engine — hồi quy: thiếu trường chấm công', () => {
  const cfg = { periodEnd: '2025-06-30', taxRegime: 'LEGACY_7B' as const };
  const emp = (attendance: Record<string, number>) =>
    ({
      employeeId: 'emp-1',
      employeeCode: 'NV001',
      fullName: 'Test',
      costAccount: '6422',
      contract: { baseSalary: 25_000_000, contractSalary: 30_000_000, maxKpiSalary: 0 },
      insurance: { wageRegion: 'I' as const },
      attendance,
      dependents: 2,
    }) as never;

  it('chỉ truyền workedDays + scheduledDays vẫn tính đúng gross', () => {
    const r = calculatePayroll(emp({ workedDays: 26, scheduledDays: 26 }), cfg);
    expect(r.prorateRatio).toBe(1);
    expect(r.gross).toBe(25_780_000);
  });

  it('KHÔNG trường nào của attendance là NaN', () => {
    const r = calculatePayroll(emp({ workedDays: 26, scheduledDays: 26 }), cfg);
    for (const [k, v] of Object.entries(r.audit.formulaContext)) {
      if (typeof v === 'number') {
        expect(Number.isFinite(v), `formulaContext.${k} = ${v}`).toBe(true);
      }
    }
    expect(Number.isFinite(r.gross)).toBe(true);
    expect(Number.isFinite(r.net)).toBe(true);
  });

  it('gross không bao giờ bằng 0 khi có ngày công', () => {
    const r = calculatePayroll(emp({ workedDays: 20, scheduledDays: 26 }), cfg);
    expect(r.gross).toBeGreaterThan(0);
    expect(r.prorateRatio).toBeCloseTo(20 / 26, 5);
  });

  it('truyền chuỗi số vẫn chạy (dữ liệu từ Excel/CSV hay bị thế)', () => {
    const r = calculatePayroll(
      emp({ workedDays: 26 as never, scheduledDays: '26' as never, nightHours: '4' as never }),
      cfg,
    );
    // hourlyRate = round(25.000.000/26/8) = 120.192
    // phụ cấp đêm 4h = round(120.192 × 0.3 × 4) = 144.230
    const night = r.earnings.find((e) => e.code === 'NIGHT_ALLOWANCE');
    expect(night?.amount).toBe(144_230);
    expect(r.gross).toBe(25_780_000 + 144_230);
  });

  it('truyền giá trị KHÔNG phải số => NÉM LỖI, không trả về 0đ', () => {
    expect(() =>
      calculatePayroll(emp({ workedDays: 26, scheduledDays: 26, nightHours: NaN }), cfg),
    ).toThrow(/không phải số hữu hạn/);
  });

  it('normalizeAttendance điền 0 cho mọi trường thiếu', () => {
    const n = normalizeAttendance({ workedDays: 26 });
    expect(n).toEqual({
      workedDays: 26, scheduledDays: 0, paidLeaveDays: 0, unpaidLeaveDays: 0,
      nightHours: 0, otWeekdayHours: 0, otWeekendHours: 0, otHolidayHours: 0,
      lateCount: 0, lateMinutes: 0, earlyLeaveCount: 0, missingPunchCount: 0, absentDays: 0,
    });
  });
});
