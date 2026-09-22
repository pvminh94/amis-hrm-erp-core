/**
 * ============================================================================
 * CONTROLLER — BẢNG LƯƠNG
 * ============================================================================
 *
 * Quy trình vận hành:
 *   DRAFT ──lock──> LOCKED ──approve──> APPROVED ──pay──> PAID
 *
 *   - DRAFT    : tính đi tính lại bao nhiêu lần cũng được
 *   - LOCKED   : khoá dữ liệu, không sửa được nữa (chờ kế toán trưởng soát)
 *   - APPROVED : sinh bút toán kế toán kép (job post-gl-journal)
 *   - PAID     : xuất file UNC, gửi phiếu lương điện tử
 */

import express, { type Router } from 'express';
import { z } from 'zod';

import { calculatePayroll, type PayrollEmployeeInput, type PayrollConfig } from '../../domain/payroll.js';
import { buildPayrollJournalSummary } from '../../domain/gl-bridge.js';
import { generatePaymentFile } from '../../domain/payment-file.js';
import { buildPolicySnapshot, type WageRegion } from '../../config/insurance.js';
import { resolveTaxRegime } from '../../config/tax-regime.js';
import { getPrisma, dec } from '../../infra/repositories/prisma.js';
import { ApiError, asyncHandler, requirePermission, validateBody } from '../middleware/index.js';
import { enqueueIdempotent, QUEUE_NAMES } from '../../application/workers/queue.js';

const createRunSchema = z.object({
  name: z.string().min(3).max(160),
  periodYear: z.number().int().min(2000).max(2100),
  periodMonth: z.number().int().min(1).max(12),
  orgUnitId: z.string().uuid().optional(),
  taxRegime: z.enum(['AUTO', 'LEGACY_7B', 'BRIDGE_2026H1', 'VN_2026_5B']).default('AUTO'),
});

function periodBounds(year: number, month: number): { from: Date; to: Date; endIso: string } {
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 0));
  return { from, to, endIso: to.toISOString().slice(0, 10) };
}

export function payrollConfigFromEnv(env: NodeJS.ProcessEnv, periodEnd: string): Partial<PayrollConfig> {
  return {
    periodEnd,
    taxRegime: env.PAYROLL_TAX_REGIME ?? 'AUTO',
    standardWorkHours: Number(env.PAYROLL_STANDARD_WORK_HOURS ?? 8),
    standardWorkDays: Number(env.PAYROLL_STANDARD_WORK_DAYS ?? 26),
  };
}

export function createPayrollRouter(): Router {
  const router = express.Router();

  // --- TẠO BẢNG LƯƠNG & TÍNH ---------------------------------------------------
  router.post(
    '/pay-runs',
    requirePermission('payroll.run.create'),
    validateBody(createRunSchema),
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const auth = req.auth!;
      const dto = req.body as z.infer<typeof createRunSchema>;
      const { from, to, endIso } = periodBounds(dto.periodYear, dto.periodMonth);

      const code = `PR${dto.periodYear}${String(dto.periodMonth).padStart(2, '0')}`;
      const existing = await prisma.payRun.findFirst({
        where: { periodYear: dto.periodYear, periodMonth: dto.periodMonth, deletedAt: null },
      });
      if (existing) throw ApiError.conflict(`Đã tồn tại bảng lương kỳ ${dto.periodMonth}/${dto.periodYear}`);

      const regime = resolveTaxRegime(endIso, dto.taxRegime);
      const policy = buildPolicySnapshot(endIso);

      const run = await prisma.payRun.create({
        data: {
          code,
          name: dto.name,
          periodYear: dto.periodYear,
          periodMonth: dto.periodMonth,
          periodFrom: from,
          periodTo: to,
          status: 'DRAFT',
          taxRegimeCode: regime.code,
          policySnapshot: policy as unknown as object,
          orgUnitId: dto.orgUnitId ?? null,
          createdBy: auth.userId,
        },
      });

      res.status(201).json({
        id: run.id,
        code: run.code,
        status: run.status,
        taxRegime: { code: regime.code, name: regime.name, legalBasis: regime.legalBasis },
        policy,
      });
    }),
  );

  // --- TÍNH LẠI (chỉ khi DRAFT) ------------------------------------------------
  router.post(
    '/pay-runs/:id/calculate',
    requirePermission('payroll.run.create'),
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const run = await prisma.payRun.findUnique({ where: { id: String(req.params.id) } });
      if (!run) throw ApiError.notFound('Không tìm thấy bảng lương');
      if (run.status !== 'DRAFT') {
        throw ApiError.conflict(`Bảng lương đã ${run.status} — chỉ tính lại được khi ở trạng thái DRAFT`);
      }

      const endIso = new Date(run.periodTo).toISOString().slice(0, 10);
      const cfg = payrollConfigFromEnv(process.env, endIso);

      // Nạp nhân sự + chấm công kỳ
      const employees = await prisma.employee.findMany({
        where: { status: { in: ['ACTIVE', 'PROBATION'] }, deletedAt: null },
        include: {
          department: { select: { glExpenseAccount: true, code: true } },
          insurance: true,
          dependents: { where: { deletedAt: null, isVerified: true } },
          contracts: { where: { status: 'ACTIVE', deletedAt: null }, orderBy: { startDate: 'desc' }, take: 1 },
          attendances: {
            where: {
              workDate: { gte: run.periodFrom, lte: run.periodTo },
              deletedAt: null,
            },
          },
        },
      });

      const inputs: PayrollEmployeeInput[] = employees.map((e) => {
        const contract = e.contracts[0];
        const att = e.attendances;
        const sum = (f: (a: (typeof att)[number]) => number) => att.reduce((acc, x) => acc + f(x), 0);
        const workedDays = sum((a) => dec(a.standardDays));
        const scheduled = att.filter((a) => !['WEEKLY_OFF', 'HOLIDAY_OFF'].includes(a.status)).length;

        return {
          employeeId: e.id,
          employeeCode: e.code,
          fullName: e.fullName,
          costAccount: e.department?.glExpenseAccount ?? '6422',
          costCenterCode: e.department?.code,
          contract: {
            baseSalary: contract?.baseSalary ?? 0,
            contractSalary: contract?.contractSalary ?? 0,
            maxKpiSalary: contract?.maxKpiSalary ?? 0,
            isProbation: e.status === 'PROBATION',
            probationRate: contract ? dec(contract.probationRate) : 0.85,
          },
          insurance: {
            wageRegion: (e.wageRegion as WageRegion) ?? 'I',
            baseOverride: e.insurance?.siBaseOverride ?? null,
            mandatory: {
              si: e.insurance?.isSiMandatory ?? true,
              hi: e.insurance?.isHiMandatory ?? true,
              ui: e.insurance?.isUiMandatory ?? true,
            },
          },
          attendance: {
            workedDays,
            scheduledDays: scheduled,
            paidLeaveDays: att.filter((a) => a.status === 'LEAVE_PAID').length,
            unpaidLeaveDays: att.filter((a) => a.status === 'LEAVE_UNPAID').length,
            nightHours: sum((a) => dec(a.nightHours)),
            otWeekdayHours: sum((a) => dec(a.otWeekdayHours)),
            otWeekendHours: sum((a) => dec(a.otWeekendHours)),
            otHolidayHours: sum((a) => dec(a.otHolidayHours)),
            lateCount: att.filter((a) => a.status === 'LATE').length,
            lateMinutes: sum((a) => a.lateMinutes),
            earlyLeaveCount: att.filter((a) => a.earlyLeaveMin > 0).length,
            missingPunchCount: att.filter((a) => a.status === 'MISSING_PUNCH').length,
            absentDays: att.filter((a) => a.status === 'ABSENT').length,
          },
          dependents: e.dependents.length,
        };
      });

      const results: Array<ReturnType<typeof calculatePayroll>> = [];
      const errors: Array<{ code: string; error: string }> = [];
      for (const input of inputs) {
        try {
          results.push(calculatePayroll(input, cfg));
        } catch (err) {
          errors.push({ code: input.employeeCode, error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Ghi PaySlip
      await prisma.paySlip.deleteMany({ where: { payRunId: run.id } });
      let totalGross = 0;
      let totalNet = 0;
      let totalSiEmployee = 0;
      let totalSiEmployer = 0;
      let totalPit = 0;

      for (const r of results) {
        totalGross += r.gross;
        totalNet += r.net;
        totalSiEmployee += r.totalInsuranceEmployee;
        totalSiEmployer += r.totalInsuranceEmployer;
        totalPit += r.pitAmount;
        await prisma.paySlip.create({
          data: {
            payRunId: run.id,
            employeeId: r.employeeId,
            workedDays: r.prorateRatio * 26,
            standardDays: r.prorateRatio * 26,
            nightHours: r.audit.formulaContext.nightHours ?? 0,
            otWeekdayHours: r.audit.formulaContext.otWeekdayHours ?? 0,
            otWeekendHours: r.audit.formulaContext.otWeekendHours ?? 0,
            otHolidayHours: r.audit.formulaContext.otHolidayHours ?? 0,
            hourlyRate: r.hourlyRate,
            gross: r.gross,
            allowances: r.earnings
              .filter((x) => !['BASE', 'KPI', 'COMMISSION'].includes(x.code))
              .reduce((a, b) => a + b.amount, 0),
            kpiAmount: r.earnings.find((x) => x.code === 'KPI')?.amount ?? 0,
            commission: r.earnings.find((x) => x.code === 'COMMISSION')?.amount ?? 0,
            nightAllowance: r.earnings.find((x) => x.code === 'NIGHT_ALLOWANCE')?.amount ?? 0,
            otAmount: r.earnings
              .filter((x) => x.code.startsWith('OT_'))
              .reduce((a, b) => a + b.amount, 0),
            deductions: r.totalDeductions,
            siBase: r.siBase,
            siEmployee: r.insurance.employee.si,
            hiEmployee: r.insurance.employee.hi,
            uiEmployee: r.insurance.employee.ui,
            totalInsuranceEmployee: r.totalInsuranceEmployee,
            siEmployer: r.insurance.employer.si,
            hiEmployer: r.insurance.employer.hi,
            uiEmployer: r.insurance.employer.ui,
            wciEmployer: r.insurance.employer.wci,
            totalInsuranceEmployer: r.totalInsuranceEmployer,
            taxableIncome: r.pit.taxableIncome,
            earningsDetail: { earnings: r.earnings, exempt: r.taxExemptTotal } as unknown as object,
            deductionsDetail: { items: r.deductionItems, pitBreakdown: r.pit.brackets } as unknown as object,
            selfDeduction: r.pit.deductions.self,
            dependentCount: r.pit.deductions.dependentCount,
            dependentDeduction: r.pit.deductions.dependents,
            pit: r.pitAmount,
            otherDeductions: r.totalDeductions - r.advance,
            advance: r.advance,
            net: r.net,
          },
        });
      }

      await prisma.payRun.update({
        where: { id: run.id },
        data: { totalGross, totalNet, totalSiEmployee, totalSiEmployer, totalPit, headcount: results.length },
      });

      res.json({
        payRunId: run.id,
        headcount: results.length,
        totals: { totalGross, totalNet, totalSiEmployee, totalSiEmployer, totalPit },
        taxRegime: results[0]?.taxRegimeCode ?? run.taxRegimeCode,
        errors,
      });
    }),
  );

  // --- CHUYỂN TRẠNG THÁI ---------------------------------------------------------
  const changeStatus =
    (from: 'DRAFT' | 'LOCKED' | 'APPROVED', to: 'LOCKED' | 'APPROVED' | 'PAID', extra?: (id: string) => Promise<unknown>) =>
      asyncHandler(async (req, res) => {
        const prisma = getPrisma();
        const auth = req.auth!;
        const run = await prisma.payRun.findUnique({ where: { id: String(req.params.id) } });
        if (!run) throw ApiError.notFound('Không tìm thấy bảng lương');
        if (run.status !== from) throw ApiError.conflict(`Bảng lương đang ở ${run.status}, cần ${from}`);
        if (run.headcount === 0 && to === 'LOCKED') {
          throw ApiError.unprocessable('Bảng lương chưa có phiếu lương nào — chạy tính lương trước');
        }

        await prisma.payRun.update({
          where: { id: run.id },
          data: {
            status: to,
            ...(to === 'LOCKED' ? { lockedAt: new Date(), lockedBy: auth.userId } : {}),
            ...(to === 'APPROVED' ? { approvedAt: new Date(), approvedBy: auth.userId } : {}),
            ...(to === 'PAID' ? { paidAt: new Date(), paidBy: auth.userId } : {}),
          },
        });

        if (extra) await extra(run.id);

        // KÍCH HOẠT CẦU NỐI KẾ TOÁN khi duyệt
        if (to === 'APPROVED') {
          await enqueueIdempotent(QUEUE_NAMES.postGlJournal, run.id, { payRunId: run.id });
        }
        // Xuất file thanh toán + gửi phiếu lương khi chốt chi
        if (to === 'PAID') {
          await enqueueIdempotent(QUEUE_NAMES.exportPaymentFile, run.id, { payRunId: run.id });
          await enqueueIdempotent(QUEUE_NAMES.sendPayslipMail, run.id, { payRunId: run.id });
        }

        res.json({ id: run.id, status: to });
      });

  router.post('/pay-runs/:id/lock', requirePermission('payroll.run.lock'), changeStatus('DRAFT', 'LOCKED'));
  router.post('/pay-runs/:id/approve', requirePermission('payroll.run.approve'), changeStatus('LOCKED', 'APPROVED'));
  router.post('/pay-runs/:id/pay', requirePermission('payment.create'), changeStatus('APPROVED', 'PAID'));

  // --- PHIẾU LƯƠNG -------------------------------------------------------------
  router.get(
    '/pay-runs/:id/payslips',
    requirePermission('payroll.read'),
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const rows = await prisma.paySlip.findMany({
        where: { payRunId: String(req.params.id), deletedAt: null },
        include: { employee: { select: { code: true, fullName: true } } },
        orderBy: { employee: { code: 'asc' } },
      });
      res.json({ count: rows.length, data: rows });
    }),
  );

  router.get(
    '/my-payslips',
    requirePermission('self.payslip'),
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const auth = req.auth!;
      if (!auth.employeeId) throw ApiError.forbidden('Tài khoản chưa gắn hồ sơ nhân viên');
      const rows = await prisma.paySlip.findMany({
        where: { employeeId: auth.employeeId, deletedAt: null, payRun: { status: { in: ['APPROVED', 'PAID'] } } },
        include: { payRun: { select: { periodYear: true, periodMonth: true, status: true } } },
        orderBy: { payRun: { periodYear: 'desc' } },
      });
      res.json({ count: rows.length, data: rows });
    }),
  );

  // --- BÚT TOÁN KẾ TOÁN -------------------------------------------------------------
  router.get(
    '/pay-runs/:id/journals',
    requirePermission('journal.read'),
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const run = await prisma.payRun.findUnique({
        where: { id: String(req.params.id) },
        include: { journals: { include: { lines: { orderBy: { lineNo: 'asc' } } } } },
      });
      if (!run) throw ApiError.notFound('Không tìm thấy bảng lương');
      res.json({ count: run.journals.length, data: run.journals });
    }),
  );

  /** Xem trước bút toán tổng hợp (không ghi DB) — cho kế toán soát trước khi duyệt */
  router.get(
    '/pay-runs/:id/journal-preview',
    requirePermission('payroll.read'),
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const run = await prisma.payRun.findUnique({
        where: { id: String(req.params.id) },
        include: {
          paySlips: {
            include: { employee: { select: { id: true, department: { select: { code: true } } } } },
          },
        },
      });
      if (!run) throw ApiError.notFound('Không tìm thấy bảng lương');

      const amounts = run.paySlips.map((s) => ({
        employeeId: s.employeeId,
        departmentCode: s.employee.department?.code ?? 'KHAC',
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
        otherDeductions: [{ code: 'ADVANCE', amount: s.advance }],
      }));

      const { summary } = buildPayrollJournalSummary(amounts, {
        date: new Date(run.periodTo).toISOString().slice(0, 10),
        payRunId: run.id,
        periodLabel: `Kỳ lương ${String(run.periodMonth).padStart(2, '0')}/${run.periodYear}`,
      });
      res.json(summary);
    }),
  );

  // --- FILE THANH TOÁN NGÂN HÀNG -------------------------------------------------------
  router.post(
    '/pay-runs/:id/payment-file',
    requirePermission('payment.create'),
    validateBody(z.object({ bankCode: z.enum(['VCB', 'TCB', 'CTG', 'MBB', 'GENERIC']) })),
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const bankCode = (req.body as { bankCode: 'VCB' | 'TCB' | 'CTG' | 'MBB' | 'GENERIC' }).bankCode;
      const run = await prisma.payRun.findUnique({
        where: { id: String(req.params.id) },
        include: { paySlips: { include: { employee: true } } },
      });
      if (!run) throw ApiError.notFound('Không tìm thấy bảng lương');
      if (!['APPROVED', 'PAID'].includes(run.status)) {
        throw ApiError.conflict('Chỉ xuất được file thanh toán khi bảng lương đã được duyệt');
      }

      const rows = run.paySlips
        .filter((s) => s.employee.bankAccountEnc && s.net > 0)
        .map((s) => ({
          employeeId: s.employeeId,
          employeeCode: s.employee.code,
          fullName: s.employee.fullName,
          accountNumber: s.employee.bankAccountEnc ?? '', // application layer giải mã trước khi dùng
          beneficiaryName: s.employee.fullName,
          beneficiaryBankCode: s.employee.bankCode,
          beneficiaryBranch: s.employee.bankBranch ?? undefined,
          amount: s.net,
          description: `Luong T${String(run.periodMonth).padStart(2, '0')}/${run.periodYear} ${s.employee.code}`,
        }));

      if (rows.length === 0) {
        throw ApiError.unprocessable('Không có nhân viên nào đủ điều kiện chuyển khoản (thiếu STK hoặc net = 0)');
      }

      const file = generatePaymentFile({
        batchNo: run.code,
        date: new Date().toISOString().slice(0, 10),
        payer: {
          name: process.env.COMPANY_LEGAL_NAME ?? 'CONG TY CO PHAN CONG NGHE AMIS',
          accountNumber: process.env.COMPANY_BANK_ACCOUNT ?? '0071000000000',
          bankCode: bankCode,
          taxCode: process.env.COMPANY_TAX_CODE,
        },
        bank: bankCode,
        purpose: 'SALARY',
        periodLabel: `${String(run.periodMonth).padStart(2, '0')}/${run.periodYear}`,
        rows,
      });

      await prisma.paymentFile.create({
        data: {
          payRunId: run.id,
          bankCode: bankCode as never,
          fileName: file.fileName,
          fileFormat: file.format,
          checksum: file.checksum,
          rowCount: file.rowCount,
          totalAmount: file.totalAmount,
          storagePath: `/var/amis/payment-files/${file.fileName}`,
        },
      });

      res.setHeader('Content-Type', file.format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
      res.send(file.content);
    }),
  );

  return router;
}
