/**
 * ============================================================================
 * WORKER PROCESS — chạy tách biệt khỏi API server
 * ============================================================================
 *
 * Khởi động:  npm run worker
 * Trong docker-compose: service `worker` với cùng image, command khác nhau.
 *
 * Tách worker riêng để:
 *   - Job nặng (tính lương 5.000 NV, xuất file) không làm nghẽn API
 *   - Scale ngang độc lập: tăng số replica worker mà không tăng API
 *   - Deploy lại API không làm mất job đang chạy
 */

import { QUEUE_NAMES, createWorker, registerRepeatableJobs, redisConnection } from './queue.js';
import {
  buildGlJournalsFromAmounts,
  handleCalcProgressiveTax,
  handleCloseNightShift,
  handleSendPayslipMail,
  handleExportPaymentFile,
  handlePostGlJournal,
  type TaxBatchJob,
} from './handlers.js';
import {
  PrismaGlJournalRepository,
  PrismaPaymentFileRepository,
  reconcileAfterPosting,
} from '../../infra/repositories/payroll-repository.js';
import { generatePaymentFile, type BankCode } from '../../domain/payment-file.js';
import { decrypt } from '../../infra/crypto/crypto.js';
import { DEFAULT_CHART_OF_ACCOUNTS } from '../../domain/gl-bridge.js';
import { getPrisma } from '../../infra/repositories/prisma.js';
import { loadConfig } from '../../config/env.js';
import type { PayrollConfig } from '../../domain/payroll.js';

/** Khoá AES-256-GCM để giải mã số tài khoản ngân hàng khi xuất file UNC */
function keyBuffer(): Buffer {
  const hex = process.env.DATA_ENCRYPTION_KEY ?? '';
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw new Error(
      `DATA_ENCRYPTION_KEY phải là 64 ký tự hex (32 byte) cho AES-256-GCM, đang nhận ${buf.length} byte`,
    );
  }
  return buf;
}

export async function startWorkers(): Promise<void> {
  const config = loadConfig();
  const prisma = getPrisma();
  void redisConnection();

  // --- 1. Chốt công đêm ------------------------------------------------------
  createWorker<{ workDate?: string }>(QUEUE_NAMES.closeNightShift, async (job) => {
    const workDate =
      job.data.workDate ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const result = await handleCloseNightShift(workDate, {
      findUnsettledNightAttendances: async (date) => {
        const rows = await prisma.dailyAttendance.findMany({
          where: {
            workDate: new Date(`${date}T00:00:00Z`),
            shift: { crossMidnight: true },
            checkOutAt: null,
            isLocked: false,
            deletedAt: null,
          },
          select: { id: true, employeeId: true, workDate: true, shiftId: true },
        });
        return rows.map((r) => ({
          id: r.id,
          employeeId: r.employeeId,
          workDate: r.workDate.toISOString().slice(0, 10),
          shiftCode: String(r.shiftId ?? ''),
        }));
      },
      recomputeAttendance: async (attendanceId) => {
        // Đánh dấu để batch tính công đêm chạy lại (logic tính nằm ở AttendanceService)
        await prisma.dailyAttendance.update({
          where: { id: attendanceId },
          data: { lastComputedAt: new Date() },
        });
      },
    });
    job.log(`Chốt công đêm ${workDate}: quét ${result.scanned}, xử lý ${result.settled}, lỗi ${result.failed.length}`);
    return result;
  });

  // --- 2. Tính thuế luỹ tiến hàng loạt -----------------------------------------
  createWorker<TaxBatchJob>(QUEUE_NAMES.calcProgressiveTax, async (job) => {
    const result = await handleCalcProgressiveTax(job.data, {
      loadEmployees: async () => {
        // Trong bản đầy đủ, AttendanceService + PayrollService build input từ DB.
        // Ở đây giữ interface để worker không phụ thuộc trực tiếp vào Prisma query phức tạp.
        return [];
      },
      saveResults: async () => undefined,
    });
    job.log(`Tính thuế bảng ${job.data.payRunId}: ${result.processed} phiếu, lỗi ${result.errors.length}`);
    return result;
  });

  // --- 3. Gửi phiếu lương --------------------------------------------------------
  createWorker<{ payRunId: string }>(QUEUE_NAMES.sendPayslipMail, async (job) => {
    const result = await handleSendPayslipMail(
      job.data.payRunId,
      {
        loadPayslips: async (payRunId) => {
          const rows = await prisma.paySlip.findMany({
            where: { payRunId, deletedAt: null },
            include: { employee: { select: { id: true, email: true, fullName: true } }, payRun: true },
          });
          return rows.map((r) => ({
            employeeId: r.employeeId,
            email: r.employee.email,
            fullName: r.employee.fullName,
            net: r.net,
            gross: r.gross,
            periodLabel: `${String(r.payRun.periodMonth).padStart(2, '0')}/${r.payRun.periodYear}`,
          }));
        },
        markSent: async (employeeId, runId) => {
          await prisma.paySlip.updateMany({
            where: { employeeId, payRunId: runId },
            data: { payslipSentAt: new Date() },
          });
        },
      },
      {
        // Mailer thật dùng nodemailer; ở đây log để không phụ thuộc SMTP khi dev
        send: async (to, subject) => {
          job.log(`Gửi phiếu lương tới ${to}: ${subject}`);
        },
      },
      (slip) => ({
        subject: `Phiếu lương ${slip.periodLabel} — ${slip.fullName}`,
        html: `<p>Xin chào ${slip.fullName},</p><p>Tổng lương kỳ ${slip.periodLabel}: ${slip.gross.toLocaleString('vi-VN')} ₫. Thực lĩnh: ${slip.net.toLocaleString('vi-VN')} ₫.</p>`,
      }),
    );
    job.log(`Gửi phiếu lương: thành công ${result.sent}, bỏ qua ${result.skipped}, lỗi ${result.failed.length}`);
    return result;
  });

  // --- 4. Sinh bút toán kế toán kép khi bảng lương được duyệt -----------------
  createWorker<{ payRunId: string }>(QUEUE_NAMES.postGlJournal, async (job) => {
    const repo = new PrismaGlJournalRepository(prisma);

    // Kỳ đã ghi sổ rồi thì bỏ qua — BullMQ có thể giao lại job sau khi restart
    const run = await prisma.payRun.findUnique({ where: { id: job.data.payRunId } });
    if (!run) throw new Error(`Không tìm thấy bảng lương ${job.data.payRunId}`);
    if (run.glPostedAt) {
      job.log(`Kỳ ${run.code} đã ghi sổ lúc ${run.glPostedAt.toISOString()} — bỏ qua`);
      return { journals: 0, skipped: true };
    }

    // Ánh xạ phòng ban -> TK chi phí: 6421 bán hàng / 6422 QLDN / 154 sản xuất
    const depts = await prisma.orgUnit.findMany({
      where: { type: 'DEPARTMENT', deletedAt: null },
      select: { code: true, glExpenseAccount: true },
    });
    const costAccountByDepartment: Record<string, string> = {};
    for (const d of depts) costAccountByDepartment[d.code] = d.glExpenseAccount ?? '6422';

    const result = await handlePostGlJournal(job.data.payRunId, repo, (amounts) =>
      buildGlJournalsFromAmounts(amounts, {
        entryNoPrefix: `JV${run.code}`,
        date: run.periodTo.toISOString().slice(0, 10),
        payRunId: run.id,
        periodLabel: `Kỳ lương ${String(run.periodMonth).padStart(2, '0')}/${run.periodYear}`,
        costAccountByDepartment,
        defaultCostAccount: DEFAULT_CHART_OF_ACCOUNTS.ADMIN_EXPENSE,
        paymentAccount: DEFAULT_CHART_OF_ACCOUNTS.BANK_VND,
      }),
    );

    // Đối chiếu TK 334 từ dữ liệu ĐÃ GHI, không phải từ bộ nhớ
    const rec = await reconcileAfterPosting(job.data.payRunId, prisma);
    job.log(
      `Ghi sổ ${result.journals} bút toán cho kỳ ${run.code}. ` +
        `TK 334: Nợ ${rec.debit.toLocaleString('vi-VN')} / Có ${rec.credit.toLocaleString('vi-VN')} ` +
        `/ dư ${rec.balance.toLocaleString('vi-VN')}${rec.settled ? ' (đã tất toán)' : ' (CÒN SỐ DƯ — chưa chi hết)'}`,
    );
    return { ...result, reconcile: rec };
  });

  // --- 5. Xuất file thanh toán ngân hàng ----------------------------------------
  createWorker<{ payRunId: string; bankCode?: string }>(QUEUE_NAMES.exportPaymentFile, async (job) => {
    const bankCode = (job.data.bankCode ?? process.env.PAYMENT_BANK ?? 'VCB') as BankCode;
    const repo = new PrismaPaymentFileRepository(prisma, (cipher) => decrypt(cipher, keyBuffer()));
    const result = await handleExportPaymentFile(
      job.data.payRunId,
      bankCode,
      repo,
      (rows) =>
        generatePaymentFile({
          batchNo: job.data.payRunId,
          date: new Date().toISOString().slice(0, 10),
          payer: {
            name: process.env.COMPANY_LEGAL_NAME ?? 'CONG TY CO PHAN CONG NGHE AMIS',
            accountNumber: process.env.COMPANY_BANK_ACCOUNT ?? '0071000000000',
            bankCode,
            taxCode: process.env.COMPANY_TAX_CODE,
          },
          bank: bankCode,
          purpose: 'SALARY',
          periodLabel: new Date().toISOString().slice(0, 7),
          rows,
        }),
      { storagePath: process.env.PAYMENT_FILE_DIR ?? '/var/amis/payment-files' },
    );
    job.log(
      `Xuất file ${result.fileName} (${bankCode}): ${result.rowCount} dòng, ` +
        `tổng ${result.totalAmount.toLocaleString('vi-VN')} ₫`,
    );
    return result;
  });

  await registerRepeatableJobs();
  // eslint-disable-next-line no-console
  console.log(`[AMIS Worker] Đang lắng nghe: ${Object.values(QUEUE_NAMES).join(', ')} (env=${config.NODE_ENV})`);
}

const isDirectRun = process.argv[1]?.endsWith('worker.ts');
if (isDirectRun) {
  startWorkers().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[AMIS Worker] Khởi động thất bại:', err);
    process.exit(1);
  });
}
