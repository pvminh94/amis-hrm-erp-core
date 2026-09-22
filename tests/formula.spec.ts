/**
 * Kiểm thử DYNAMIC FORMULA BUILDER (tokenizer / parser / evaluator) và
 * biểu thuế luỹ tiến + tách thu nhập miễn thuế.
 */
import { describe, expect, it } from 'vitest';

import {
  compileFormula,
  evalFormula,
  extractVariables,
  FormulaError,
  tokenize,
  validateFormula,
} from '../src/domain/formula.js';
import { computeProgressiveTax, computeQuickFormulaTax, computePersonalIncomeTax } from '../src/domain/pit.js';
import { REGIME_LEGACY_7B, REGIME_VN_2026_5B } from '../src/config/tax-regime.js';
import { classifyEarnings, splitOvertimeTaxExemption } from '../src/domain/income-tax.js';

describe('tokenize', () => {
  it('tách số, biến, toán tử', () => {
    const t = tokenize('baseSalary * 0.1 + 1_000');
    expect(t.map((x) => x.type)).toEqual(['ident', 'op', 'num', 'op', 'num', 'eof']);
    expect(t[4]!.value).toBe('1000'); // dấu _ được bỏ
  });
  it('toán tử 2 ký tự', () => {
    const t = tokenize('a >= b && c != d');
    expect(t.map((x) => x.value)).toEqual(['a', '>=', 'b', '&&', 'c', '!=', 'd', '']);
  });
  it('bắt lỗi ký tự lạ', () => {
    expect(() => tokenize('a $ b')).toThrow(FormulaError);
  });
  it('số không hợp lệ', () => {
    expect(() => tokenize('1.2.3')).toThrow(FormulaError);
  });
});

describe('evalFormula — số học', () => {
  it('cộng trừ nhân chia và độ ưu tiên', () => {
    expect(evalFormula('2 + 3 * 4', {})).toBe(14);
    expect(evalFormula('(2 + 3) * 4', {})).toBe(20);
    expect(evalFormula('10 - 2 - 3', {})).toBe(5); // trái sang phải
    expect(evalFormula('100 / 5 / 2', {})).toBe(10);
    expect(evalFormula('7 % 3', {})).toBe(1);
  });
  it('luỹ thừa phải kết hợp', () => {
    expect(evalFormula('2 ^ 3 ^ 2', {})).toBe(512); // 2^(3^2)
  });
  it('unary trừ và NOT', () => {
    expect(evalFormula('-5 + 3', {})).toBe(-2);
    expect(evalFormula('--5', {})).toBe(5);
  });
  it('chia 0 trả về 0 (không crash công thức lương)', () => {
    expect(evalFormula('100 / 0', {})).toBe(0);
    expect(evalFormula('100 % 0', {})).toBe(0);
  });
  it('biến chưa khai báo = 0', () => {
    expect(evalFormula('a + 10', {})).toBe(10);
    expect(() => evalFormula('a + 10', {}, { onMissingVar: 'throw' })).toThrow(/chưa được khai báo/);
  });
  it('biến boolean', () => {
    expect(evalFormula('x ? 100 : 0', { x: true })).toBe(100);
    expect(evalFormula('x ? 100 : 0', { x: false })).toBe(0);
  });
});

describe('evalFormula — so sánh và logic', () => {
  it('toán tử so sánh', () => {
    expect(evalFormula('5 > 3', {})).toBe(1);
    expect(evalFormula('5 < 3', {})).toBe(0);
    expect(evalFormula('5 >= 5', {})).toBe(1);
    expect(evalFormula('5 <= 4', {})).toBe(0);
  });
  it('so sánh bằng lỏng về kiểu', () => {
    expect(evalFormula('a == 3', { a: 3 })).toBe(1);
    expect(evalFormula('a != 3', { a: 4 })).toBe(1);
  });
  it('short-circuit && và ||', () => {
    expect(evalFormula('a > 10 && b > 10', { a: 5, b: 100 })).toBe(0);
    expect(evalFormula('a > 10 || b > 10', { a: 5, b: 100 })).toBe(1);
  });
  it('toán tử ba ngôi lồng nhau', () => {
    expect(evalFormula('d >= 3 ? 100 : d >= 2 ? 50 : 10', { d: 3 })).toBe(100);
    expect(evalFormula('d >= 3 ? 100 : d >= 2 ? 50 : 10', { d: 2 })).toBe(50);
    expect(evalFormula('d >= 3 ? 100 : d >= 2 ? 50 : 10', { d: 1 })).toBe(10);
  });
});

describe('evalFormula — hàm có sẵn', () => {
  it('round half-up', () => {
    expect(evalFormula('round(2.5)', {})).toBe(3);
    expect(evalFormula('round(2.4)', {})).toBe(2);
    expect(evalFormula('round(-2.5)', {})).toBe(-3);
  });
  it('round1000 làm tròn xuống nghìn', () => {
    expect(evalFormula('round1000(12450)', {})).toBe(12000);
  });
  it('min / max / clamp / cap', () => {
    expect(evalFormula('min(10, 20, 5)', {})).toBe(5);
    expect(evalFormula('max(10, 20, 5)', {})).toBe(20);
    expect(evalFormula('clamp(150, 0, 100)', {})).toBe(100);
    expect(evalFormula('cap(9999999, 5000000)', {})).toBe(5000000);
    expect(evalFormula('floorAt(100, 500)', {})).toBe(500);
  });
  it('tier luỹ tiến', () => {
    // 3% đến 500tr, 5% từ 500tr–1tỷ, 7% trên 1 tỷ
    const f = 'tier(x, 500000000, 0.03, 1000000000, 0.05, 999999999999, 0.07)';
    expect(evalFormula(f, { x: 300_000_000 })).toBe(9_000_000);
    expect(evalFormula(f, { x: 800_000_000 })).toBe(15_000_000 + 15_000_000);
    expect(evalFormula(f, { x: 1_500_000_000 })).toBe(15_000_000 + 25_000_000 + 35_000_000);
  });
  it('if() dạng hàm', () => {
    expect(evalFormula('if(a > 5, 100, 0)', { a: 10 })).toBe(100);
    expect(evalFormula('if(a > 5, 100, 0)', { a: 1 })).toBe(0);
  });
  it('hàm không tồn tại → lỗi', () => {
    expect(() => evalFormula('khongCoHam(1)', {})).toThrow(/không tồn tại/);
  });
  it('sai số tham số → lỗi', () => {
    expect(() => evalFormula('round(1, 2)', {})).toThrow(/tham số/);
  });
});

describe('evalFormula — AN TOÀN (không eval)', () => {
  it('không truy cập được global/process', () => {
    expect(evalFormula('process', {})).toBe(0);
    expect(() => evalFormula('process.exit(1)', {})).toThrow();
  });
  it('không cho phép gán', () => {
    expect(validateFormula('a = 5').ok).toBe(false);
  });
  it('biểu thức rỗng → lỗi', () => {
    expect(() => compileFormula('')).toThrow(/rỗng/);
    expect(validateFormula('   ').ok).toBe(false);
  });
  it('thiếu đóng ngoặc → lỗi', () => {
    expect(validateFormula('(1 + 2').ok).toBe(false);
  });
  it('thừa token → lỗi', () => {
    expect(validateFormula('1 2').ok).toBe(false);
  });
});

describe('extractVariables / validateFormula', () => {
  it('liệt kê biến được tham chiếu', () => {
    expect(extractVariables('round(baseSalary * kpiScore / 100) + maxKpiSalary').sort()).toEqual([
      'baseSalary',
      'kpiScore',
      'maxKpiSalary',
    ]);
  });
  it('không liệt kê tên hàm', () => {
    expect(extractVariables('min(a, b)')).toEqual(['a', 'b']);
  });
  it('validateFormula trả về biến khi hợp lệ', () => {
    const r = validateFormula('a > b ? c : d');
    expect(r.ok).toBe(true);
    expect(r.variables.sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('compileFormula có cache', () => {
    const a = compileFormula('1 + 1');
    const b = compileFormula('1 + 1');
    expect(a).toBe(b);
  });
});

// ===========================================================================
// THUẾ LUỸ TIẾN
// ===========================================================================

describe('computeProgressiveTax — luỹ tiến từng phần', () => {
  it('7 bậc: 10.000.000 → 750.000', () => {
    // 5tr×5% + 5tr×10% = 250.000 + 500.000
    expect(computeProgressiveTax(10_000_000, REGIME_LEGACY_7B.brackets).tax).toBe(750_000);
  });

  it('7 bậc: khớp bảng đối chiếu đã công bố', () => {
    const cases: Array<[number, number]> = [
      [5_000_000, 250_000],
      [10_000_000, 750_000],
      [18_000_000, 1_950_000],
      [32_000_000, 4_750_000],
      [52_000_000, 9_750_000],
      [80_000_000, 18_150_000],
      [100_000_000, 25_150_000],
    ];
    for (const [income, expected] of cases) {
      expect(computeProgressiveTax(income, REGIME_LEGACY_7B.brackets).tax, `TNTT ${income}`).toBe(expected);
    }
  });

  it('5 bậc 2026: kiểm tra TỪNG BẬC bằng tay (không dựa vào bảng bên thứ ba)', () => {
    // Bậc: ≤10tr 5% | 10–30tr 10% | 30–60tr 20% | 60–100tr 30% | >100tr 35%
    const cases: Array<[number, number, string]> = [
      [10_000_000, 500_000, '10tr×5%'],
      [20_000_000, 500_000 + 1_000_000, '500k + 10tr×10%'],
      [30_000_000, 500_000 + 2_000_000, '500k + 2tr'],
      [50_000_000, 500_000 + 2_000_000 + 4_000_000, '+ 20tr×20%'],
      [60_000_000, 500_000 + 2_000_000 + 6_000_000, '+ 30tr×20%'],
      [80_000_000, 500_000 + 2_000_000 + 6_000_000 + 6_000_000, '+ 20tr×30% = 14.5tr'],
      [100_000_000, 500_000 + 2_000_000 + 6_000_000 + 12_000_000, '+ 40tr×30% = 20.5tr'],
      [120_000_000, 20_500_000 + 7_000_000, '+ 20tr×35%'],
    ];
    for (const [income, expected, note] of cases) {
      expect(
        computeProgressiveTax(income, REGIME_VN_2026_5B.brackets).tax,
        `TNTT ${income} (${note})`,
      ).toBe(expected);
    }
    // Đối chiếu công thức rút gọn: >100tr → TNTT×35% − 14.500.000
    expect(computeQuickFormulaTax(120_000_000, REGIME_VN_2026_5B.brackets)).toBe(27_500_000);
  });

  it('5 bậc luôn cho thuế THẤP HƠN hoặc bằng 7 bậc (đúng mục tiêu cải cách)', () => {
    for (let income = 1_000_000; income <= 200_000_000; income += 1_000_000) {
      const oldTax = computeProgressiveTax(income, REGIME_LEGACY_7B.brackets).tax;
      const newTax = computeProgressiveTax(income, REGIME_VN_2026_5B.brackets).tax;
      expect(newTax, `TNTT ${income}`).toBeLessThanOrEqual(oldTax);
    }
  });

  it('thu nhập 0 hoặc âm → thuế 0', () => {
    expect(computeProgressiveTax(0, REGIME_LEGACY_7B.brackets).tax).toBe(0);
    expect(computeProgressiveTax(-100, REGIME_LEGACY_7B.brackets).tax).toBe(0);
    expect(computeProgressiveTax(0, REGIME_LEGACY_7B.brackets).brackets).toHaveLength(0);
  });

  it('công thức rút gọn khớp luỹ tiến từng phần ở MỌI mức thu nhập', () => {
    for (const regime of [REGIME_LEGACY_7B, REGIME_VN_2026_5B]) {
      for (let income = 0; income <= 300_000_000; income += 137_000) {
        const step = computeProgressiveTax(income, regime.brackets).tax;
        const quick = computeQuickFormulaTax(income, regime.brackets);
        expect(Math.abs(step - quick), `${regime.code} TNTT ${income}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it('chi tiết từng bậc được trả về để giải trình', () => {
    // 20.000.000: bậc1 5tr, bậc2 5tr, bậc3 8tr (10→18tr), bậc4 2tr (18→20tr)
    const r = computeProgressiveTax(20_000_000, REGIME_LEGACY_7B.brackets);
    expect(r.brackets).toHaveLength(4);
    expect(r.brackets[0]).toMatchObject({ level: 1, portion: 5_000_000, rate: 0.05 });
    expect(r.brackets[2]).toMatchObject({ level: 3, portion: 8_000_000, rate: 0.15 });
    expect(r.brackets[3]).toMatchObject({ level: 4, portion: 2_000_000, rate: 0.2 });
    expect(r.tax).toBe(2_350_000);
  });

  it('thu nhập đúng bằng cận dưới của bậc → KHÔNG sinh dòng bậc rỗng', () => {
    // 18.000.000 là đúng cận trên bậc 3 / cận dưới bậc 4 → chỉ có 3 dòng
    const r = computeProgressiveTax(18_000_000, REGIME_LEGACY_7B.brackets);
    expect(r.brackets).toHaveLength(3);
    expect(r.brackets[2]!).toMatchObject({ level: 3, portion: 8_000_000 });
    expect(r.tax).toBe(1_950_000);
  });
});

describe('computePersonalIncomeTax — giảm trừ gia cảnh', () => {
  it('LEGACY_7B: giảm trừ 11tr + 4.4tr/NPT', () => {
    const r = computePersonalIncomeTax({
      assessableIncome: 30_000_000,
      mandatoryInsurance: 3_150_000,
      dependents: 2,
      periodEnd: '2025-06-30',
      regime: 'LEGACY_7B',
    });
    expect(r.deductions.self).toBe(11_000_000);
    expect(r.deductions.dependents).toBe(8_800_000);
    expect(r.deductions.total).toBe(22_950_000);
    expect(r.taxableIncome).toBe(7_050_000);
    // 5tr×5% + 2.05tr×10% = 250.000 + 205.000 = 455.000
    expect(r.tax).toBe(455_000);
  });

  it('VN_2026_5B: giảm trừ 15.5tr + 6.2tr/NPT', () => {
    const r = computePersonalIncomeTax({
      assessableIncome: 30_000_000,
      mandatoryInsurance: 3_150_000,
      dependents: 2,
      periodEnd: '2026-09-30',
      regime: 'VN_2026_5B',
    });
    expect(r.deductions.self).toBe(15_500_000);
    expect(r.deductions.dependents).toBe(12_400_000);
    expect(r.taxableIncome).toBe(0);
    expect(r.tax).toBe(0);
  });

  it('thu nhập dưới giảm trừ → không phát sinh thuế', () => {
    const r = computePersonalIncomeTax({
      assessableIncome: 12_000_000,
      mandatoryInsurance: 1_000_000,
      dependents: 0,
      periodEnd: '2025-06-30',
      regime: 'LEGACY_7B',
    });
    // 12.000.000 − 1.000.000 (BH) − 11.000.000 (bản thân) = 0
    expect(r.taxableIncome).toBe(0);
    expect(r.tax).toBe(0);
    expect(r.notes.some((n) => n.includes('không phát sinh thuế'))).toBe(true);
  });

  it('không áp dụng giảm trừ gia cảnh cho thu nhập vãng lai', () => {
    const r = computePersonalIncomeTax({
      assessableIncome: 30_000_000,
      mandatoryInsurance: 0,
      dependents: 2,
      applyFamilyDeduction: false,
      periodEnd: '2025-06-30',
      regime: 'LEGACY_7B',
    });
    expect(r.deductions.self).toBe(0);
    expect(r.deductions.dependents).toBe(0);
    expect(r.taxableIncome).toBe(30_000_000);
  });

  it('trần quỹ hưu trí tự nguyện 1.000.000đ/tháng', () => {
    const r = computePersonalIncomeTax({
      assessableIncome: 40_000_000,
      mandatoryInsurance: 0,
      dependents: 0,
      voluntaryPension: 5_000_000,
      periodEnd: '2025-06-30',
      regime: 'LEGACY_7B',
    });
    expect(r.deductions.voluntaryPension).toBe(1_000_000);
    expect(r.notes.some((n) => n.includes('vượt trần'))).toBe(true);
  });

  it('làm tròn số NPT lẻ xuống số nguyên', () => {
    const r = computePersonalIncomeTax({
      assessableIncome: 40_000_000,
      mandatoryInsurance: 0,
      dependents: 1.7,
      periodEnd: '2025-06-30',
      regime: 'LEGACY_7B',
    });
    expect(r.deductions.dependentCount).toBe(1);
  });

  it('bắt lỗi thu nhập chịu thuế âm', () => {
    expect(() =>
      computePersonalIncomeTax({
        assessableIncome: -1,
        mandatoryInsurance: 0,
        dependents: 0,
        periodEnd: '2025-06-30',
      }),
    ).toThrow(/không được âm/);
  });
});

// ===========================================================================
// TÁCH THU NHẬP MIỄN THUẾ
// ===========================================================================

describe('classifyEarnings — phân loại chịu thuế / miễn thuế', () => {
  it('TAXABLE / EXEMPT / PARTIAL', () => {
    const r = classifyEarnings([
      { code: 'A', name: 'Lương', amount: 10_000_000, taxTreatment: 'TAXABLE' },
      { code: 'B', name: 'Trợ cấp', amount: 2_000_000, taxTreatment: 'EXEMPT' },
      { code: 'C', name: 'Ăn trưa', amount: 900_000, taxTreatment: 'PARTIAL', exemptCap: 730_000 },
    ]);
    expect(r.totalAmount).toBe(12_900_000);
    expect(r.totalTaxable).toBe(10_000_000 + 170_000);
    expect(r.totalExempt).toBe(2_000_000 + 730_000);
  });
  it('PARTIAL với amount < cap → miễn toàn bộ', () => {
    const r = classifyEarnings([
      { code: 'C', name: 'Ăn trưa', amount: 500_000, taxTreatment: 'PARTIAL', exemptCap: 730_000 },
    ]);
    expect(r.totalTaxable).toBe(0);
    expect(r.totalExempt).toBe(500_000);
  });
});

describe('splitOvertimeTaxExemption — miễn thuế phần OT cao hơn lương thường', () => {
  it('OT ngày thường 150%: chịu 100%, miễn 50%', () => {
    const r = splitOvertimeTaxExemption({
      normalHourlyRate: 100_000,
      otWeekdayHours: 4,
      otWeekendHours: 0,
      otHolidayHours: 0,
      nightHours: 0,
    });
    expect(r.totalPaid).toBe(600_000);
    expect(r.taxableAmount).toBe(400_000);
    expect(r.exemptAmount).toBe(200_000);
  });

  it('OT ngày nghỉ tuần 200%: chịu 100%, miễn 100%', () => {
    const r = splitOvertimeTaxExemption({
      normalHourlyRate: 100_000,
      otWeekdayHours: 0,
      otWeekendHours: 4,
      otHolidayHours: 0,
      nightHours: 0,
    });
    expect(r.totalPaid).toBe(800_000);
    expect(r.taxableAmount).toBe(400_000);
    expect(r.exemptAmount).toBe(400_000);
  });

  it('OT ngày lễ 300%: chịu 100%, miễn 200%', () => {
    const r = splitOvertimeTaxExemption({
      normalHourlyRate: 100_000,
      otWeekdayHours: 0,
      otWeekendHours: 0,
      otHolidayHours: 2,
      nightHours: 0,
    });
    expect(r.totalPaid).toBe(600_000);
    expect(r.taxableAmount).toBe(200_000);
    expect(r.exemptAmount).toBe(400_000);
  });

  it('phụ cấp đêm 30% miễn thuế toàn bộ', () => {
    const r = splitOvertimeTaxExemption({
      normalHourlyRate: 100_000,
      otWeekdayHours: 0,
      otWeekendHours: 0,
      otHolidayHours: 0,
      nightHours: 10,
    });
    expect(r.totalPaid).toBe(300_000);
    expect(r.taxableAmount).toBe(0);
    expect(r.exemptAmount).toBe(300_000);
    expect(r.legalBasis).toContain('111/2013');
  });
});
