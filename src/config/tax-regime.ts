/**
 * ============================================================================
 * THAM SỐ THUẾ TNCN VIỆT NAM — CÓ PHIÊN BẢN THEO NGÀY HIỆU LỰC
 * ============================================================================
 *
 * ⚠️  LƯU Ý PHÁP LÝ QUAN TRỌNG (cập nhật tại thời điểm bàn giao):
 *
 *  Đề bài yêu cầu "Biểu thuế lũy tiến từng phần 7 bậc" và
 *  "Giảm trừ gia cảnh 11.000.000 / 4.400.000". Đó là quy định của
 *  Luật Thuế TNCN 2007 + Nghị quyết 954/2020/UBTVQH14 — ĐÃ KHÔNG CÒN
 *  là quy định hiện hành cho kỳ tính thuế 2026.
 *
 *  Quy định hiện hành:
 *   1. Nghị quyết 110/2025/UBTVQH15 (hiệu lực 01/01/2026, áp dụng từ kỳ
 *      tính thuế năm 2026):
 *        - Giảm trừ bản thân:      15.500.000 đ/tháng  (186.000.000 đ/năm)
 *        - Giảm trừ người phụ thuộc: 6.200.000 đ/người/tháng
 *   2. Luật Thuế TNCN 2025 số 109/2025/QH15 (Quốc hội thông qua 10/12/2025,
 *      hiệu lực 01/07/2026): rút gọn biểu thuế từ 7 bậc xuống 5 bậc
 *      (5% / 10% / 20% / 30% / 35%), nới rộng khoảng cách bậc.
 *
 *  Vì có hai mốc hiệu lực khác nhau (giảm trừ từ 01/01/2026, biểu thuế
 *  từ 01/07/2026) và vì bảng lương phải TÁI LẬP ĐƯỢC (reproducible) cho
 *  kỳ cũ, hệ thống KHÔNG hardcode một bộ số duy nhất mà dùng TaxRegime
 *  có ngày hiệu lực. Engine mặc định AUTO sẽ tự chọn chế độ đúng theo
 *  kỳ lương; có thể ép bằng PAYROLL_TAX_REGIME=LEGACY_7B để đúng nguyên
 *  văn spec (dùng cho kỳ lương trước 2026 / đối soát dữ liệu cũ).
 *
 *  NGUỒN TRA CỨU (đã kiểm chứng khi viết file này):
 *   - Luật Thuế thu nhập cá nhân 2007, Phụ lục biểu thuế 7 bậc (Điều 22)
 *   - Nghị quyết 954/2020/UBTVQH14
 *   - Nghị quyết 110/2025/UBTVQH15
 *   - Luật Thuế TNCN 2025 số 109/2025/QH15, Điều 9 (biểu thuế) & Điều 29
 *     (giảm trừ gia cảnh)
 * ============================================================================
 */

export interface TaxBracket {
  /** Bậc (1-based) */
  level: number;
  /** Cận dưới của phần thu nhập tính thuế (đ/tháng), bao gồm */
  from: number;
  /** Cận trên (đ/tháng), không bao gồm. Number.POSITIVE_INFINITY cho bậc cuối */
  to: number;
  /** Thuế suất, dạng thập phân (0.05 = 5%) */
  rate: number;
  /** Số trừ nhanh: thuế = TNTT * rate - quickDeduction */
  quickDeduction: number;
}

export interface TaxRegime {
  code: string;
  name: string;
  /** Căn cứ pháp lý */
  legalBasis: string;
  /** Ngày hiệu lực (ISO). Chế độ áp dụng cho kỳ lương bắt đầu >= ngày này */
  effectiveFrom: string;
  /** Ngày hết hiệu lực, null = còn hiệu lực */
  effectiveTo: string | null;
  brackets: TaxBracket[];
  selfDeduction: number;
  dependentDeduction: number;
  /** Mức khấu trừ 10% cho thu nhập vãng lai >= ngưỡng này */
  occasionalIncomeThreshold: number;
  /** Trần đóng quỹ hưu trí tự nguyện được trừ (đ/tháng) */
  voluntaryPensionCap: number;
}

/**
 * Biểu thuế 7 bậc — Luật Thuế TNCN 2007 (Phụ lục Điều 22) + NQ 954/2020.
 * Đây là chế độ được nêu NGUYÊN VĂN trong đề bài.
 *
 *  Bậc | TNTT/tháng        | Thuế suất | Số trừ nhanh
 *  ----+-------------------+-----------+--------------
 *   1  | đến 5.000.000     |    5%     |           0
 *   2  | trên 5 – 10 tr    |   10%     |     250.000
 *   3  | trên 10 – 18 tr   |   15%     |     750.000
 *   4  | trên 18 – 32 tr   |   20%     |   1.650.000
 *   5  | trên 32 – 52 tr   |   25%     |   3.250.000
 *   6  | trên 52 – 80 tr   |   30%     |   5.850.000
 *   7  | trên 80 tr        |   35%     |   9.850.000
 */
export const REGIME_LEGACY_7B: TaxRegime = {
  code: 'LEGACY_7B',
  name: 'Biểu thuế 7 bậc — Luật TNCN 2007 + NQ 954/2020/UBTVQH14',
  legalBasis:
    'Điều 22 Luật Thuế TNCN 2007; Nghị quyết 954/2020/UBTVQH14 về giảm trừ gia cảnh',
  effectiveFrom: '2020-07-01',
  effectiveTo: '2025-12-31',
  brackets: [
    { level: 1, from: 0, to: 5_000_000, rate: 0.05, quickDeduction: 0 },
    { level: 2, from: 5_000_000, to: 10_000_000, rate: 0.1, quickDeduction: 250_000 },
    { level: 3, from: 10_000_000, to: 18_000_000, rate: 0.15, quickDeduction: 750_000 },
    { level: 4, from: 18_000_000, to: 32_000_000, rate: 0.2, quickDeduction: 1_650_000 },
    { level: 5, from: 32_000_000, to: 52_000_000, rate: 0.25, quickDeduction: 3_250_000 },
    { level: 6, from: 52_000_000, to: 80_000_000, rate: 0.3, quickDeduction: 5_850_000 },
    { level: 7, from: 80_000_000, to: Number.POSITIVE_INFINITY, rate: 0.35, quickDeduction: 9_850_000 },
  ],
  selfDeduction: 11_000_000,
  dependentDeduction: 4_400_000,
  occasionalIncomeThreshold: 2_000_000,
  voluntaryPensionCap: 1_000_000,
};

/**
 * Chế độ chuyển tiếp: giảm trừ gia cảnh MỚI (từ kỳ thuế 2026, NQ 110/2025)
 * nhưng vẫn dùng biểu 7 bậc — áp dụng cho kỳ lương 01/01/2026 → 30/06/2026
 * nếu doanh nghiệp khấu trừ theo tháng trước khi Luật 109/2025 có hiệu lực.
 */
export const REGIME_BRIDGE_2026H1: TaxRegime = {
  code: 'BRIDGE_2026H1',
  name: 'Giảm trừ mới (NQ 110/2025) + biểu 7 bậc — kỳ 01/01/2026–30/06/2026',
  legalBasis: 'Nghị quyết 110/2025/UBTVQH15; Điều 22 Luật Thuế TNCN 2007',
  effectiveFrom: '2026-01-01',
  effectiveTo: '2026-06-30',
  brackets: REGIME_LEGACY_7B.brackets,
  selfDeduction: 15_500_000,
  dependentDeduction: 6_200_000,
  occasionalIncomeThreshold: 2_000_000,
  voluntaryPensionCap: 1_000_000,
};

/**
 * Biểu thuế 5 bậc — Luật Thuế TNCN 2025 số 109/2025/QH15 (hiệu lực 01/07/2026).
 *
 *  Bậc | TNTT/tháng           | Thuế suất | Số trừ nhanh
 *  ----+----------------------+-----------+--------------
 *   1  | đến 10.000.000       |    5%     |           0
 *   2  | trên 10 – 30 tr      |   10%     |     500.000
 *   3  | trên 30 – 60 tr      |   20%     |   3.500.000
 *   4  | trên 60 – 100 tr     |   30%     |   9.500.000
 *   5  | trên 100 tr          |   35%     |  14.500.000
 */
export const REGIME_VN_2026_5B: TaxRegime = {
  code: 'VN_2026_5B',
  name: 'Biểu thuế 5 bậc — Luật Thuế TNCN 2025 (109/2025/QH15)',
  legalBasis: 'Điều 9 & Điều 29 Luật Thuế thu nhập cá nhân 2025 số 109/2025/QH15',
  effectiveFrom: '2026-07-01',
  effectiveTo: null,
  brackets: [
    { level: 1, from: 0, to: 10_000_000, rate: 0.05, quickDeduction: 0 },
    { level: 2, from: 10_000_000, to: 30_000_000, rate: 0.1, quickDeduction: 500_000 },
    { level: 3, from: 30_000_000, to: 60_000_000, rate: 0.2, quickDeduction: 3_500_000 },
    { level: 4, from: 60_000_000, to: 100_000_000, rate: 0.3, quickDeduction: 9_500_000 },
    { level: 5, from: 100_000_000, to: Number.POSITIVE_INFINITY, rate: 0.35, quickDeduction: 14_500_000 },
  ],
  selfDeduction: 15_500_000,
  dependentDeduction: 6_200_000,
  occasionalIncomeThreshold: 2_000_000,
  voluntaryPensionCap: 1_000_000,
};

/** Danh sách chế độ, sắp theo ngày hiệu lực tăng dần */
export const TAX_REGIMES: readonly TaxRegime[] = [
  REGIME_LEGACY_7B,
  REGIME_BRIDGE_2026H1,
  REGIME_VN_2026_5B,
];

/**
 * Chọn chế độ thuế áp dụng cho một kỳ lương.
 * Quy ước: kỳ lương tháng M năm Y được xem là phát sinh vào NGÀY CUỐI kỳ
 * (periodEnd), vì đây là thời điểm chi trả và xác định nghĩa vụ khấu trừ.
 *
 * @param periodEnd Ngày cuối kỳ lương
 * @param forcedCode Ép chế độ (PAYROLL_TAX_REGIME), 'AUTO' hoặc null = tự chọn
 */
export function resolveTaxRegime(
  periodEnd: Date | string,
  forcedCode?: string | null,
): TaxRegime {
  if (forcedCode && forcedCode.toUpperCase() !== 'AUTO') {
    const found = TAX_REGIMES.find((r) => r.code.toUpperCase() === forcedCode.toUpperCase());
    if (!found) {
      throw new Error(
        `Không tìm thấy chế độ thuế "${forcedCode}". Các mã hợp lệ: ${TAX_REGIMES.map((r) => r.code).join(', ')}`,
      );
    }
    return found;
  }
  const d = new Date(periodEnd);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Ngày kỳ lương không hợp lệ: ${String(periodEnd)}`);
  }
  // Duyệt ngược từ mới nhất để lấy chế độ có hiệu lực gần nhất <= periodEnd
  for (let i = TAX_REGIMES.length - 1; i >= 0; i -= 1) {
    const regime = TAX_REGIMES[i]!;
    const from = new Date(`${regime.effectiveFrom}T00:00:00Z`);
    const to = regime.effectiveTo ? new Date(`${regime.effectiveTo}T23:59:59Z`) : null;
    if (d >= from && (to === null || d <= to)) return regime;
  }
  // Kỳ trước 01/07/2020 → fallback về chế độ legacy
  return REGIME_LEGACY_7B;
}
