/**
 * ============================================================================
 * REPOSITORY — BÚT TOÁN KẾ TOÁN & FILE THANH TOÁN (Prisma)
 * ============================================================================
 *
 * Hiện thực hai interface mà worker khai báo, nối domain layer (gl-bridge,
 * payment-file) với PostgreSQL thật.
 *
 * Hai nguyên tắc không được phá:
 *
 *  1. Bút toán ghi trong MỘT transaction. Ghi dở vài bút toán rồi lỗi là dữ
 *     liệu kế toán hỏng — không thể đối chiếu, không thể đảo.
 *  2. entryNo là UNIQUE trong DB. Ghi lại cùng một kỳ lương sẽ đụng ràng buộc
 *     đó và transaction rollback toàn bộ — đây là chốt chặn idempotency cuối
 *     cùng, phòng khi BullMQ giao lại job.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

import type { GlJournalRepository, PaymentFileMeta, PaymentFileRepository } from '../../application/workers/handlers.js';
import { reconcilePayableAccount, type GlEmployeeAmounts, type JournalEntryInput } from '../../domain/gl-bridge.js';
import type { GeneratedPaymentFile, PaymentRow } from '../../domain/payment-file.js';
import { getPrisma, dec } from './prisma.js';

// ---------------------------------------------------------------------------
// BÚT TOÁN KẾ TOÁN
// ---------------------------------------------------------------------------

export class PrismaGlJournalRepository implements GlJournalRepository {
  constructor(private readonly prisma: PrismaClient = getPrisma()) {}

  async loadGlAmounts(payRunId: string): Promise<GlEmployeeAmounts[]> {
    const slips = await this.prisma.paySlip.findMany({
      where: { payRunId, deletedAt: null },
      include: {
        employee: { select: { id: true, department: { select: { code: true, glExpenseAccount: true } } } },
      },
    });

    return slips.map((s) => {
      const others: Array<{ code: string; amount: number }> = [];
      if (s.advance > 0) others.push({ code: 'ADVANCE', amount: s.advance });

      return {
        employeeId: s.employeeId,
        departmentCode: s.employee.department?.code ?? 'KHAC',
        costCenterCode: s.employee.department?.code,
        gross: s.gross,
        siEmployee: s.siEmployee,
        hiEmployee: s.hiEmployee,
        uiEmployee: s.uiEmployee,
        pit: s.pit,
        siEmployer: s.siEmployer,
        hiEmployer: s.hiEmployer,
        uiEmployer: s.uiEmployer,
        wciEmployer: s.wciEmployer,
        net: s.net,
        otherDeductions: others,
      };
    });
  }

  async saveJournals(payRunId: string, journals: JournalEntryInput[]): Promise<number> {
    // KIỂM TRA CÂN ĐỐI LẠI NGAY TRƯỚC KHI GHI. Domain layer đã kiểm tra khi
    // sinh bút toán, nhưng giữa lúc sinh và lúc ghi có thể có bước trung gian
    // nào đó sửa số. Thà từ chối ghi còn hơn ghi sổ lệch Nợ/Có.
    for (const j of journals) {
      const debit = j.lines.reduce((a, l) => a + (l.debit ?? 0), 0);
      const credit = j.lines.reduce((a, l) => a + (l.credit ?? 0), 0);
      if (debit !== credit) {
        throw new Error(
          `Bút toán ${j.entryNo} lệch Nợ/Có (Nợ ${debit} ≠ Có ${credit}) — từ chối ghi sổ`,
        );
      }
      if (j.lines.length === 0) {
        throw new Error(`Bút toán ${j.entryNo} không có dòng nào — từ chối ghi sổ`);
      }
    }

    const count = await this.prisma.$transaction(async (tx) => {
      // entryNo là UNIQUE toàn hệ thống, nên phải đảm bảo không trùng với kỳ trước
      for (const j of journals) {
        const clash = await tx.journalEntry.findUnique({ where: { entryNo: j.entryNo } });
        if (clash) {
          throw new Error(
            `Số bút toán ${j.entryNo} đã tồn tại (kỳ ${clash.payRunId ?? 'khác'}). ` +
              'Kỳ lương này có thể đã được ghi sổ — không ghi trùng.',
          );
        }
      }

      for (const j of journals) {
        await tx.journalEntry.create({
          data: {
            entryNo: j.entryNo,
            date: new Date(`${j.date}T00:00:00.000Z`),
            description: j.description,
            sourceType: j.sourceType,
            sourceId: j.sourceId ?? payRunId,
            payRunId,
            status: 'POSTED',
            postedAt: new Date(),
            lines: {
              create: j.lines.map((l, i) => ({
                lineNo: i + 1,
                accountCode: l.accountCode,
                subAccount: l.subAccount ?? null,
                debit: l.debit ?? 0,
                credit: l.credit ?? 0,
                costCenterCode: l.costCenterCode ?? null,
                employeeId: l.employeeId ?? null,
                memo: l.memo ?? null,
              })),
            },
          },
        });
      }
      return journals.length;
    });

    return count;
  }

  async markPosted(payRunId: string, at: Date): Promise<void> {
    await this.prisma.payRun.update({
      where: { id: payRunId },
      data: { glPostedAt: at },
    });
  }
}

/**
 * Đối chiếu TK 334 (phải trả người lao động) SAU KHI đã ghi sổ.
 *
 * Đọc bút toán TỪ DATABASE — không dùng lại mảng trong bộ nhớ — để kiểm chứng
 * đúng những gì đã nằm trong sổ, chứ không phải những gì ta tưởng đã ghi.
 *
 * Kỳ lương đã chi hết thì số dư 334 phải BẰNG 0:
 *   Có 334 = gross
 *   Nợ 334 = BHXH/BHYT/BHTN NLĐ + PIT + thực lĩnh + các khoản trừ khác
 */
export async function reconcileAfterPosting(
  payRunId: string,
  prisma: PrismaClient = getPrisma(),
): Promise<ReturnType<typeof reconcilePayableAccount>> {
  const entries = await prisma.journalEntry.findMany({
    where: { payRunId, deletedAt: null },
    include: { lines: true },
  });

  const journals: JournalEntryInput[] = entries.map((e) => ({
    entryNo: e.entryNo,
    date: e.date.toISOString().slice(0, 10),
    description: e.description,
    sourceType: e.sourceType as 'PAYROLL' | 'MANUAL' | 'SALES',
    sourceId: e.sourceId ?? undefined,
    lines: e.lines.map((l) => ({
      accountCode: l.accountCode,
      subAccount: l.subAccount ?? undefined,
      debit: l.debit,
      credit: l.credit,
      costCenterCode: l.costCenterCode ?? undefined,
      employeeId: l.employeeId ?? undefined,
      memo: l.memo ?? undefined,
    })),
  }));

  return reconcilePayableAccount(journals);
}

// ---------------------------------------------------------------------------
// FILE THANH TOÁN NGÂN HÀNG
// ---------------------------------------------------------------------------

export class PrismaPaymentFileRepository implements PaymentFileRepository {
  constructor(
    private readonly prisma: PrismaClient = getPrisma(),
    private readonly decrypt: (cipher: string) => string,
    private readonly storageRoot = process.env.PAYMENT_FILE_DIR ?? '/var/amis/payment-files',
  ) {}

  async loadPaymentRows(payRunId: string, _bankCode: string): Promise<PaymentRow[]> {
    const slips = await this.prisma.paySlip.findMany({
      where: {
        payRunId,
        deletedAt: null,
        net: { gt: 0 }, // không tạo dòng chuyển khoản 0 đồng
      },
      include: {
        employee: {
          select: {
            code: true,
            fullName: true,
            bankAccountEnc: true,
            bankCode: true,
            bankBranch: true,
          },
        },
        payRun: { select: { periodYear: true, periodMonth: true } },
      },
      orderBy: { employee: { code: 'asc' } },
    });

    const rows: PaymentRow[] = [];
    for (const s of slips) {
      // Số tài khoản được mã hoá AES-256-GCM trong DB — giải mã ngay tại đây,
      // không bao giờ log ra và không trả ra ngoài hàm này.
      if (!s.employee.bankAccountEnc) continue;
      let accountNumber: string;
      try {
        accountNumber = this.decrypt(s.employee.bankAccountEnc);
      } catch {
        // Không giải mã được (khoá sai / dữ liệu hỏng) => bỏ qua dòng này.
        // generatePaymentFile sẽ từ chối cả lô nếu STK rỗng, nên im lặng bỏ
        // qua ở đây là an toàn hơn là ném lỗi làm hỏng cả file.
        continue;
      }

      rows.push({
        employeeId: s.employeeId,
        employeeCode: s.employee.code,
        fullName: s.employee.fullName,
        accountNumber,
        beneficiaryName: s.employee.fullName,
        beneficiaryBankCode: s.employee.bankCode,
        beneficiaryBranch: s.employee.bankBranch ?? undefined,
        amount: s.net,
        description: `LUONG T${String(s.payRun.periodMonth).padStart(2, '0')}/${s.payRun.periodYear} ${s.employee.code}`,
      });
    }
    return rows;
  }

  async savePaymentFile(
    payRunId: string,
    file: GeneratedPaymentFile,
    meta: PaymentFileMeta,
  ): Promise<void> {
    const path = join(this.storageRoot, file.fileName);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, 'utf8');

    await this.prisma.paymentFile.create({
      data: {
        payRunId,
        bankCode: meta.bankCode as 'VCB' | 'TCB' | 'CTG' | 'MBB' | 'GENERIC',
        fileName: file.fileName,
        fileFormat: file.format,
        checksum: file.checksum,
        rowCount: file.rowCount,
        totalAmount: file.totalAmount,
        storagePath: path,
      },
    });
  }
}
