/**
 * ============================================================================
 * BACKGROUND WORKERS — xử lý bất đồng bộ
 * ============================================================================
 *
 *  1. sync-raw-punch       : ghi RawPunch từ thiết bị/mobile, khử trùng lặp,
 *                            đẩy job tính lại công ngày.
 *  2. close-night-shift    : 06:30 mỗi ngày, chốt công các ca đêm vắt 0h
 *                            của ngày hôm trước (vì lúc 23:59 chưa có quẹt ra).
 *  3. calc-progressive-tax : tính thuế luỹ tiến hàng loạt cho cả bảng lương
 *                            theo từng lô (batch) để không chặn event loop.
 *  4. send-payslip-mail    : gửi phiếu lương điện tử (đã khoá/chốt).
 *  5. post-gl-journal      : sinh bút toán kế toán kép khi bảng lương APPROVED.
 *  6. export-payment-file  : xuất file UNC theo ngân hàng.
 *
 * Mỗi handler đều NHẬN dependency qua tham số (không import trực tiếp DB)
 * nên có thể kiểm thử bằng stub mà không cần Redis/Postgres.
 */

import { calculatePayrollBatch, type PayrollConfig, type PayrollEmployeeInput } from '../../domain/payroll.js';
import {
  buildPayrollJournalsForEmployee,
  type GlEmployeeAmounts,
  type GlPayrollInput,
  type JournalEntryInput,
} from '../../domain/gl-bridge.js';
import type { GeneratedPaymentFile, PaymentRow } from '../../domain/payment-file.js';

// ---------------------------------------------------------------------------
// 1. ĐỒNG BỘ NHẬT KÝ QUẺT THẺ THÔ
// ---------------------------------------------------------------------------

export interface RawPunchInput {
  deviceUserId?: string | null;
  serialNumber?: string | null;
  employeeId?: string | null;
  punchAt: Date;
  source: string;
  verifyState?: number;
  latitude?: number | null;
  longitude?: number | null;
  accuracyM?: number | null;
  bssid?: string | null;
  livenessScore?: number | null;
  rawPayload?: unknown;
}

export interface PunchRepository {
  insertIfAbsent(punch: RawPunchInput & { dedupeHash: string }): Promise<boolean>;
  mapDeviceUserToDevice(serialNumber: string, deviceUserId: string): Promise<string | null>;
  enqueueRecalculate(employeeId: string, workDate: string): Promise<void>;
}

/** Ngày công vụ của một quẹt: ca đêm bắt đầu sau 18:00 thuộc NGÀY HÔM TRƯỚC */
export function resolveWorkDate(punchAt: Date, tzOffsetHours = 7): string {
  const local = new Date(punchAt.getTime() + tzOffsetHours * 3_600_000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  // Quẹt từ 00:00–06:00 thường là giờ RA của ca đêm hôm trước
  const dayShift = minutes < 6 * 60 ? -1 : 0;
  const d = new Date(local.getTime() + dayShift * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export async function handleSyncRawPunch(
  input: RawPunchInput,
  repo: PunchRepository,
  dedupeHash: string,
): Promise<{ inserted: boolean; employeeId: string | null; workDate: string }> {
  const inserted = await repo.insertIfAbsent({ ...input, dedupeHash });
  let employeeId = input.employeeId ?? null;
  if (!employeeId && input.serialNumber && input.deviceUserId) {
    employeeId = await repo.mapDeviceUserToDevice(input.serialNumber, input.deviceUserId);
  }
  const workDate = resolveWorkDate(input.punchAt);
  if (inserted && employeeId) {
    await repo.enqueueRecalculate(employeeId, workDate);
  }
  return { inserted, employeeId, workDate };
}

// ---------------------------------------------------------------------------
// 2. CHỐT CÔNG ĐÊM
// ---------------------------------------------------------------------------

export interface NightShiftCloseRepository {
  findUnsettledNightAttendances(workDate: string): Promise<
    Array<{ id: string; employeeId: string; workDate: string; shiftCode: string }>
  >;
  recomputeAttendance(attendanceId: string): Promise<void>;
}

export async function handleCloseNightShift(
  workDate: string,
  repo: NightShiftCloseRepository,
): Promise<{ scanned: number; settled: number; failed: string[] }> {
  const rows = await repo.findUnsettledNightAttendances(workDate);
  let settled = 0;
  const failed: string[] = [];
  for (const row of rows) {
    try {
      await repo.recomputeAttendance(row.id);
      settled += 1;
    } catch (e) {
      failed.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { scanned: rows.length, settled, failed };
}

// ---------------------------------------------------------------------------
// 3. TÍNH THUẾ LUỸ TIẾN HÀNG LOẠT
// ---------------------------------------------------------------------------

export interface TaxBatchRepository {
  loadEmployees(payRunId: string): Promise<PayrollEmployeeInput[]>;
  saveResults(payRunId: string, results: Array<{ employeeId: string; net: number; pit: number; gross: number }>): Promise<void>;
}

export interface TaxBatchJob {
  payRunId: string;
  /** Kích thước lô — mặc định 500 để giới hạn bộ nhớ với 5.000 nhân sự */
  batchSize?: number;
  config?: Partial<PayrollConfig>;
}

/**
 * Tính lương + thuế cho cả bảng theo lô. Với 5.000 nhân sự và batchSize 500
 * sẽ chạy 10 lô tuần tự, mỗi lô là một tác vụ đồng bộ ngắn.
 */
export async function handleCalcProgressiveTax(
  job: TaxBatchJob,
  repo: TaxBatchRepository,
): Promise<{ processed: number; errors: Array<{ employeeCode: string; error: string }>; totalTax: number }> {
  const batchSize = job.batchSize ?? 500;
  const employees = await repo.loadEmployees(job.payRunId);
  const errors: Array<{ employeeCode: string; error: string }> = [];
  const saved: Array<{ employeeId: string; net: number; pit: number; gross: number }> = [];
  let totalTax = 0;

  for (let i = 0; i < employees.length; i += batchSize) {
    const slice = employees.slice(i, i + batchSize);
    const { results, errors: batchErrors } = calculatePayrollBatch(slice, job.config ?? {});
    errors.push(...batchErrors);
    for (const r of results) {
      totalTax += r.pitAmount;
      saved.push({ employeeId: r.employeeId, net: r.net, pit: r.pitAmount, gross: r.gross });
    }
  }

  if (saved.length > 0) await repo.saveResults(job.payRunId, saved);
  return { processed: saved.length, errors, totalTax };
}

// ---------------------------------------------------------------------------
// 4. GỬI PHIẾU LƯƠNG
// ---------------------------------------------------------------------------

export interface PayslipMailRepository {
  loadPayslips(payRunId: string): Promise<
    Array<{ employeeId: string; email: string | null; fullName: string; net: number; gross: number; periodLabel: string }>
  >;
  markSent(employeeId: string, payRunId: string, at: Date): Promise<void>;
}

export interface Mailer {
  send(to: string, subject: string, body: string, attachments?: Array<{ filename: string; content: Buffer }>): Promise<void>;
}

export async function handleSendPayslipMail(
  payRunId: string,
  repo: PayslipMailRepository,
  mailer: Mailer,
  renderPayslip: (slip: { fullName: string; periodLabel: string; gross: number; net: number }) => { subject: string; html: string; pdf?: Buffer },
): Promise<{ sent: number; skipped: number; failed: string[] }> {
  const slips = await repo.loadPayslips(payRunId);
  let sent = 0;
  let skipped = 0;
  const failed: string[] = [];

  for (const slip of slips) {
    if (!slip.email) {
      skipped += 1;
      continue;
    }
    try {
      const rendered = renderPayslip(slip);
      await mailer.send(
        slip.email,
        rendered.subject,
        rendered.html,
        rendered.pdf ? [{ filename: `payslip_${slip.employeeId}.pdf`, content: rendered.pdf }] : undefined,
      );
      await repo.markSent(slip.employeeId, payRunId, new Date());
      sent += 1;
    } catch (e) {
      failed.push(`${slip.employeeId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { sent, skipped, failed };
}

// ---------------------------------------------------------------------------
// 5 & 6. BÚT TOÁN KẾ TOÁN VÀ FILE THANH TOÁN
// ---------------------------------------------------------------------------

export interface GlJournalRepository {
  /** Nạp số liệu lương đã chốt của kỳ, kèm mã phòng ban để chọn TK chi phí */
  loadGlAmounts(payRunId: string): Promise<GlEmployeeAmounts[]>;
  /** Ghi bút toán kép. PHẢI là một transaction — bút toán dở dang là dữ liệu hỏng */
  saveJournals(payRunId: string, journals: JournalEntryInput[]): Promise<number>;
  markPosted(payRunId: string, at: Date): Promise<void>;
}

export interface PaymentFileRepository {
  loadPaymentRows(payRunId: string, bankCode: string): Promise<PaymentRow[]>;
  savePaymentFile(payRunId: string, file: GeneratedPaymentFile, meta: PaymentFileMeta): Promise<void>;
}

/** Thông tin bổ sung để ghi bản ghi PaymentFile vào DB */
export interface PaymentFileMeta {
  bankCode: string;
  storagePath: string;
}

/**
 * Sinh bút toán kế toán kép từ số liệu lương đã duyệt.
 *
 * Dùng `buildPayrollJournalsForEmployee` (bút toán CHI TIẾT theo từng nhân viên)
 * chứ không dùng bản tổng hợp, vì:
 *   - Kế toán cần truy vết được bút toán nào thuộc nhân viên nào
 *   - Đối chiếu với bảng lương theo từng người khi có khiếu nại
 * Mỗi entry đã được `assertBalanced` kiểm tra NỢ = CÓ ngay trong domain layer.
 */
export function buildGlJournalsFromAmounts(
  amounts: readonly GlEmployeeAmounts[],
  cfg: Partial<GlPayrollInput>,
): JournalEntryInput[] {
  const journals: JournalEntryInput[] = [];
  for (const emp of amounts) {
    journals.push(...buildPayrollJournalsForEmployee(emp, cfg));
  }
  return journals;
}

export async function handlePostGlJournal(
  payRunId: string,
  repo: GlJournalRepository,
  build: (amounts: GlEmployeeAmounts[]) => JournalEntryInput[],
): Promise<{ journals: number }> {
  const amounts = await repo.loadGlAmounts(payRunId);
  if (amounts.length === 0) return { journals: 0 };
  const journals = build(amounts);
  if (journals.length === 0) return { journals: 0 };
  const count = await repo.saveJournals(payRunId, journals);
  await repo.markPosted(payRunId, new Date());
  return { journals: count };
}

export async function handleExportPaymentFile(
  payRunId: string,
  bankCode: string,
  repo: PaymentFileRepository,
  build: (rows: PaymentRow[]) => GeneratedPaymentFile,
  meta: Omit<PaymentFileMeta, 'bankCode'>,
): Promise<{ fileName: string; rowCount: number; totalAmount: number }> {
  const rows = await repo.loadPaymentRows(payRunId, bankCode);
  if (rows.length === 0) {
    throw new Error(
      `Không có dòng thanh toán nào cho kỳ ${payRunId} (ngân hàng ${bankCode}). ` +
        'Kiểm tra nhân viên có số tài khoản và lương thực lĩnh > 0.',
    );
  }
  // generatePaymentFile tự từ chối khi dữ liệu sai (STK quá ngắn, tên trống...)
  const file = build(rows);
  await repo.savePaymentFile(payRunId, file, { bankCode, ...meta });
  return { fileName: file.fileName, rowCount: file.rowCount, totalAmount: file.totalAmount };
}
