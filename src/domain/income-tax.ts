/**
 * ============================================================================
 * PHÂN LOẠI THU NHẬP CHỊU THUẾ / MIỄN THUẾ TNCN
 * ============================================================================
 *
 * Đây là bước dễ sai nhất khi tính lương VN: KHÔNG PHẢI mọi khoản thu nhập
 * đều chịu thuế TNCN. Các khoản miễn thuế phổ biến:
 *
 *  1. Tiền lương làm THÊM GIỜ, làm việc BAN ĐÊM được trả CAO HƠN so với
 *     tiền lương của ngày làm việc bình thường.
 *     => điểm i khoản 1 Điều 3 Thông tư 111/2013/TT-BTC
 *     => CHỈ PHẦN CHÊNH LỆCH được miễn. Phần bằng lương ngày thường vẫn chịu thuế.
 *     Ví dụ: lương giờ ngày thường 100.000đ, OT 150% = 150.000đ
 *            => miễn 50.000đ, chịu thuế 100.000đ.
 *
 *  2. Tiền ĂN GIỮA CA: không tính vào thu nhập chịu thuế nếu chi bằng tiền
 *     không vượt quá mức quy định. Phần VƯỢT mới chịu thuế.
 *     (khoản 5 Điều 11 Thông tư 92/2015/TT-BTC sửa đổi TT 111/2013)
 *     Mức cụ thể do doanh nghiệp quy định trong quy chế; hệ thống để
 *     cấu hình `mealTaxExemptCap` (mặc định 730.000 đ/tháng theo thông lệ
 *     phổ biến — PHẢI điều chỉnh theo quy chế nội bộ của khách hàng).
 *
 *  3. Phụ cấp XĂNG XE, ĐIỆN THOẠI, ĐI LẠI: miễn theo MỨC khoán quy định
 *     trong quy chế tài chính/HĐLĐ. Phần vượt mức khoán chịu thuế.
 *     (công văn hướng dẫn của Tổng cục Thuế theo từng trường hợp)
 *
 *  4. Trợ cấp thôi việc, trợ cấp mất việc, trợ cấp tai nạn lao động,
 *     trợ cấp thai sản, trợ cấp ốm đau từ quỹ BHXH — MIỄN toàn bộ.
 *
 *  5. Tiền thưởng cải tiến kỹ thuật, sáng chế được cơ quan nhà nước công nhận
 *     — MIỄN. Tiền thưởng lương tháng 13, thưởng doanh số — CHỊU THUẾ.
 *
 * Hệ thống tách riêng `taxable` và `exempt` cho TỪNG khoản thu nhập để
 * phiếu lương giải trình được với cơ quan thuế.
 */

import { roundVnd } from './money.js';

export interface EarningItem {
  code: string;
  name: string;
  amount: number;
  /** 'TAXABLE' | 'EXEMPT' | 'PARTIAL' (chỉ phần vượt ngưỡng chịu thuế) */
  taxTreatment: 'TAXABLE' | 'EXEMPT' | 'PARTIAL';
  /** Ngưỡng miễn thuế (cho PARTIAL) */
  exemptCap?: number;
  /** Ghi chú căn cứ pháp lý */
  legalBasis?: string;
}

export interface EarningClassification {
  items: Array<EarningItem & { taxableAmount: number; exemptAmount: number }>;
  totalAmount: number;
  totalTaxable: number;
  totalExempt: number;
  notes: string[];
}

/** Phân loại một khoản thu nhập thành phần chịu thuế / miễn thuế */
export function classifyEarning(
  item: Omit<EarningItem, 'taxTreatment'> & Partial<EarningItem>,
): EarningItem & { taxableAmount: number; exemptAmount: number } {
  const amount = roundVnd(item.amount);
  const treatment = item.taxTreatment ?? 'TAXABLE';

  if (treatment === 'EXEMPT') {
    return { ...item, amount, taxTreatment: 'EXEMPT', taxableAmount: 0, exemptAmount: amount };
  }
  if (treatment === 'PARTIAL') {
    const cap = roundVnd(item.exemptCap ?? 0);
    const exempt = Math.min(amount, cap);
    return {
      ...item,
      amount,
      taxTreatment: 'PARTIAL',
      taxableAmount: amount - exempt,
      exemptAmount: exempt,
    };
  }
  return { ...item, amount, taxTreatment: 'TAXABLE', taxableAmount: amount, exemptAmount: 0 };
}

/** Phân loại cả danh sách khoản thu nhập */
export function classifyEarnings(items: readonly EarningItem[]): EarningClassification {
  const notes: string[] = [];
  const classified = items.map((i) => {
    const r = classifyEarning(i);
    if (r.exemptAmount > 0 && r.taxTreatment === 'PARTIAL') {
      notes.push(
        `${r.name}: miễn thuế phần ${r.exemptAmount.toLocaleString('vi-VN')}đ trong ngưỡng ${r.exemptCap?.toLocaleString('vi-VN')}đ, phần vượt ${r.taxableAmount.toLocaleString('vi-VN')}đ chịu thuế`,
      );
    } else if (r.exemptAmount > 0) {
      notes.push(`${r.name}: miễn thuế toàn bộ (${r.legalBasis ?? 'theo quy định'})`);
    }
    return r;
  });
  return {
    items: classified,
    totalAmount: classified.reduce((a, b) => a + b.amount, 0),
    totalTaxable: classified.reduce((a, b) => a + b.taxableAmount, 0),
    totalExempt: classified.reduce((a, b) => a + b.exemptAmount, 0),
    notes,
  };
}

// ---------------------------------------------------------------------------
// TÍNH PHẦN LƯƠNG OT / ĐÊM ĐƯỢC MIỄN THUẾ
// ---------------------------------------------------------------------------

export interface OtTaxSplitInput {
  /** Lương giờ của NGÀY LÀM VIỆC BÌNH THƯỜNG (đơn giá gốc, chưa nhân hệ số) */
  normalHourlyRate: number;
  /** Số giờ OT từng loại */
  otWeekdayHours: number;
  otWeekendHours: number;
  otHolidayHours: number;
  /** Giờ làm đêm trong ca chính (hệ số 130%) */
  nightHours: number;
  /** Hệ số áp dụng (tối thiểu theo luật) */
  rates?: {
    weekday: number;
    weekend: number;
    holiday: number;
    night: number;
    /** Phần cộng thêm khi OT vào ban đêm (30%) */
    otNightExtra: number;
    /** Phần bù 20% khi OT ban đêm */
    otNightSupplement: number;
  };
}

export const OT_TAX_RATES = {
  weekday: 1.5,
  weekend: 2.0,
  holiday: 3.0,
  night: 0.3,
  otNightExtra: 0.3,
  otNightSupplement: 0.2,
};

export interface OtTaxSplit {
  /** Tổng tiền OT/đêm trả cho NLĐ */
  totalPaid: number;
  /** Phần bằng lương ngày thường => CHỊU THUẾ */
  taxableAmount: number;
  /** Phần chênh lệch cao hơn lương ngày thường => MIỄN THUẾ */
  exemptAmount: number;
  breakdown: Array<{ label: string; hours: number; paid: number; taxable: number; exempt: number }>;
  legalBasis: string;
}

/**
 * Tách phần miễn thuế của tiền làm thêm giờ / làm đêm.
 *
 * Cơ chế: với mỗi giờ OT, NLĐ nhận `rate × normalHourly`. Trong đó
 * `1 × normalHour` là phần "bằng lương ngày thường" => CHỊU THUẾ,
 * phần còn lại `(rate − 1) × normalHour` là phần "cao hơn" => MIỄN THUẾ.
 *
 * Riêng giờ làm đêm trong CA CHÍNH (không phải OT): theo điểm i khoản 1
 * Điều 3 TT 111/2013, phần 30% phụ cấp đêm cũng là khoản "trả cao hơn"
 * => MIỄN THUẾ. Phần 100% lương gốc vẫn chịu thuế (đã nằm trong lương).
 */
export function splitOvertimeTaxExemption(input: OtTaxSplitInput): OtTaxSplit {
  const r = { ...OT_TAX_RATES, ...(input.rates ?? {}) };
  const normal = roundVnd(input.normalHourlyRate);
  const breakdown: OtTaxSplit['breakdown'] = [];
  let totalPaid = 0;
  let totalTaxable = 0;
  let totalExempt = 0;

  const push = (
    label: string,
    hours: number,
    multiplier: number,
    /** Số phần "lương ngày thường" tính trên mỗi giờ (OT ngày lễ = 1 vì NLĐ hưởng lương ngày đã bao gồm) */
    normalPortionPerHour: number,
  ) => {
    if (hours <= 0) return;
    const paid = roundVnd(normal * multiplier * hours);
    const taxable = roundVnd(normal * normalPortionPerHour * hours);
    const exempt = paid - taxable;
    totalPaid += paid;
    totalTaxable += taxable;
    totalExempt += exempt;
    breakdown.push({ label, hours, paid, taxable, exempt });
  };

  // Hệ số TỔNG phải trả theo Điều 98 BLLĐ 2019 (không cộng dồn các hệ số):
  //   ngày thường 150% | ngày nghỉ hằng tuần 200% | ngày lễ, tết 300%
  // Trong mỗi giờ OT, phần bằng "100% lương ngày thường" chịu thuế TNCN,
  // phần chênh lệch cao hơn được MIỄN (điểm i khoản 1 Điều 3 TT 111/2013).
  push('OT ngày thường (150%)', input.otWeekdayHours, r.weekday, 1);
  push('OT ngày nghỉ hằng tuần (200%)', input.otWeekendHours, r.weekend, 1);
  push('OT ngày lễ, tết (300%)', input.otHolidayHours, r.holiday, 1);

  // Làm đêm trong ca chính: trả 100% lương + 30% phụ cấp => phần 30% miễn thuế
  if (input.nightHours > 0) {
    const paid = roundVnd(normal * r.night * input.nightHours);
    totalPaid += paid;
    totalExempt += paid;
    breakdown.push({
      label: 'Phụ cấp làm đêm 30% (Điều 98 khoản 2 BLLĐ 2019)',
      hours: input.nightHours,
      paid,
      taxable: 0,
      exempt: paid,
    });
  }

  return {
    totalPaid,
    taxableAmount: totalTaxable,
    exemptAmount: totalExempt,
    breakdown,
    legalBasis: 'Điểm i khoản 1 Điều 3 Thông tư 111/2013/TT-BTC',
  };
}
