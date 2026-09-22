/**
 * ============================================================================
 * CONTROLLER — ĐƠN TỪ & LUỒNG PHÊ DUYỆT
 * ============================================================================
 *
 *  POST /leave-requests                 : tạo đơn (DRAFT)
 *  POST /leave-requests/:id/submit      : nộp đơn → phân giải chuỗi người duyệt
 *  POST /leave-requests/:id/approve     : duyệt
 *  POST /leave-requests/:id/reject      : từ chối
 *  POST /leave-requests/:id/return      : trả lại bổ sung
 *  POST /leave-requests/:id/cancel      : huỷ
 *  GET  /leave-requests/pending         : việc cần tôi duyệt
 *  GET  /leave-requests/:id/trail       : nhật ký vết phê duyệt (bất biến)
 */

import express, { type Router } from 'express';
import { z } from 'zod';

import {
  BUSINESS_TRIP_MATRIX,
  LEAVE_APPROVAL_MATRIX,
  performApprovalAction,
  REGULARIZATION_MATRIX,
  resolveApprovalChain,
  type ApproverResolver,
  type RequestState,
  type WorkflowAction,
  type WorkflowDefinitionLike,
} from '../../domain/approval.js';
import { getPrisma, dec } from '../../infra/repositories/prisma.js';
import { ApiError, asyncHandler, requirePermission, validateBody } from '../middleware/index.js';

const createSchema = z.object({
  type: z.enum([
    'ANNUAL_LEAVE',
    'SICK_LEAVE',
    'UNPAID_LEAVE',
    'MATERNITY_LEAVE',
    'BEREAVEMENT_LEAVE',
    'MARRIAGE_LEAVE',
    'BUSINESS_TRIP',
    'REGULARIZATION',
    'OVERTIME',
    'SHIFT_SWAP',
    'OTHER',
  ]),
  title: z.string().min(3).max(160),
  reason: z.string().max(2000).optional(),
  fromDate: z.coerce.date(),
  toDate: z.coerce.date(),
  isPaid: z.boolean().default(true),
  amountVnd: z.number().int().nonnegative().optional(),
  regularizationDate: z.coerce.date().optional(),
  proposedCheckIn: z.coerce.date().optional(),
  proposedCheckOut: z.coerce.date().optional(),
});

function matrixFor(type: string): WorkflowDefinitionLike {
  if (type === 'REGULARIZATION') {
    return { code: 'WF_REGULARIZATION', name: 'Duyệt đơn giải trình', steps: REGULARIZATION_MATRIX };
  }
  if (type === 'BUSINESS_TRIP') {
    return { code: 'WF_TRIP', name: 'Duyệt đơn công tác', steps: BUSINESS_TRIP_MATRIX };
  }
  return { code: 'WF_LEAVE', name: 'Duyệt đơn nghỉ', steps: LEAVE_APPROVAL_MATRIX };
}

/** Tính số ngày giữa 2 mốc (tính cả ngày đầu và ngày cuối) */
function inclusiveDays(from: Date, to: Date): number {
  const a = new Date(`${from.toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  const b = new Date(`${to.toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  if (b < a) throw ApiError.badRequest('Ngày kết thúc phải sau ngày bắt đầu');
  return Math.round((b - a) / 86_400_000) + 1;
}

export function createApprovalRouter(): Router {
  const router = express.Router();

  // Resolver đọc từ cây tổ chức thật trong DB
  const makeResolver = (): ApproverResolver => {
    const prisma = getPrisma();
    const toPerson = (e: { userId: string | null; fullName: string } | null) =>
      e && e.userId ? { userId: e.userId, name: e.fullName } : null;

    return {
      getDirectManager: async (employeeId) => {
        const emp = await prisma.employee.findUnique({
          where: { id: employeeId },
          include: { manager: { select: { userId: true, fullName: true } } },
        });
        return toPerson(emp?.manager ?? null);
      },
      getDepartmentHead: async (employeeId) => {
        const emp = await prisma.employee.findUnique({
          where: { id: employeeId },
          include: { department: true },
        });
        const head = emp?.department?.managerId
          ? await prisma.employee.findUnique({
              where: { id: emp.department.managerId },
              select: { userId: true, fullName: true },
            })
          : null;
        return toPerson(head);
      },
      getBranchHead: async () => null,
      getByRole: async (role) => {
        const user = await prisma.user.findFirst({
          where: { role: role as never, status: 'ACTIVE', deletedAt: null },
          include: { employee: { select: { fullName: true } } },
        });
        if (!user) return null;
        return { userId: user.id, name: user.employee?.fullName ?? user.username };
      },
      getUser: async (userId) => {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          include: { employee: { select: { fullName: true } } },
        });
        return user ? { userId: user.id, name: user.employee?.fullName ?? user.username } : null;
      },
    };
  };

  // --- TẠO ĐƠN ----------------------------------------------------------------
  router.post(
    '/leave-requests',
    requirePermission('leave.create'),
    validateBody(createSchema),
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const auth = req.auth!;
      if (!auth.employeeId) throw ApiError.forbidden('Tài khoản chưa gắn hồ sơ nhân viên');
      const dto = req.body as z.infer<typeof createSchema>;

      const days = inclusiveDays(dto.fromDate, dto.toDate);
      const count = await prisma.leaveRequest.count();
      const requestNo = `LR${new Date().getFullYear()}${String(count + 1).padStart(6, '0')}`;

      const created = await prisma.leaveRequest.create({
        data: {
          requestNo,
          employeeId: auth.employeeId,
          type: dto.type as never,
          status: 'DRAFT',
          title: dto.title,
          reason: dto.reason,
          fromDate: dto.fromDate,
          toDate: dto.toDate,
          days,
          hours: days * 8,
          isPaid: dto.isPaid,
          regularizationDate: dto.regularizationDate,
          proposedCheckIn: dto.proposedCheckIn,
          proposedCheckOut: dto.proposedCheckOut,
          createdBy: auth.userId,
        },
      });
      res.status(201).json(created);
    }),
  );

  // --- NỘP ĐƠN: phân giải chuỗi người duyệt ------------------------------------
  router.post(
    '/leave-requests/:id/submit',
    requirePermission('leave.create'),
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const auth = req.auth!;
      const request = await prisma.leaveRequest.findUnique({ where: { id: String(req.params.id) } });
      if (!request) throw ApiError.notFound('Không tìm thấy đơn');
      if (request.employeeId !== auth.employeeId && auth.role === 'EMPLOYEE') {
        throw ApiError.forbidden('Chỉ được nộp đơn của chính mình');
      }
      if (request.status !== 'DRAFT' && request.status !== 'RETURNED') {
        throw ApiError.conflict(`Đơn đang ở trạng thái ${request.status}, không thể nộp lại`);
      }

      const workflow = matrixFor(request.type);
      const context = {
        days: dec(request.days),
        hours: dec(request.hours),
        type: request.type,
        isPaid: request.isPaid,
        amountVnd: Number((request.attachments as { amountVnd?: number } | null)?.amountVnd ?? 0),
      };
      const routed = await resolveApprovalChain(
        workflow,
        { requesterEmployeeId: request.employeeId, context },
        makeResolver(),
      );

      if (routed.steps.length === 0) {
        throw ApiError.unprocessable(
          `Không xác định được người duyệt cho đơn này. ${routed.errors.join(' | ')}`,
          { skipped: routed.skipped, errors: routed.errors },
        );
      }

      await prisma.$transaction(async (tx) => {
        await tx.approvalStep.deleteMany({ where: { requestId: request.id } });
        for (const s of routed.steps) {
          await tx.approvalStep.create({
            data: {
              requestId: request.id,
              step: s.step,
              approverType: s.approverType,
              approverRole: s.approverRole as never,
              approverId: s.userId,
              approverName: s.userName,
              status: s.step === 1 ? 'PENDING_APPROVAL' : 'DRAFT',
              dueAt: s.dueAt,
            },
          });
        }
        await tx.leaveRequest.update({
          where: { id: request.id },
          data: {
            status: 'PENDING_APPROVAL',
            submittedAt: new Date(),
            currentStep: 0,
            totalSteps: routed.steps.length,
            workflowId: null,
          },
        });
        await tx.approvalAuditTrail.create({
          data: {
            requestId: request.id,
            actorId: auth.userId,
            actorName: auth.username,
            actorRole: auth.role,
            action: 'SUBMIT',
            fromStatus: request.status as never,
            toStatus: 'PENDING_APPROVAL',
            step: 0,
            ipAddress: req.clientIp,
            userAgent: req.headers['user-agent']?.slice(0, 255),
            metadata: {
              totalSteps: routed.steps.length,
              skipped: routed.skipped,
              chain: routed.steps,
            } as unknown as object,
          },
        });
      });

      res.json({
        status: 'PENDING_APPROVAL',
        totalSteps: routed.steps.length,
        chain: routed.steps,
        skipped: routed.skipped,
        warnings: routed.errors,
      });
    }),
  );

  // --- DUYỆT / TỪ CHỐI / TRẢ LẠI / HUỶ -----------------------------------------
  const decide = (action: WorkflowAction) =>
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const auth = req.auth!;
      const comment = (req.body as { comment?: string })?.comment;

      const request = await prisma.leaveRequest.findUnique({
        where: { id: String(req.params.id) },
        include: { steps: { orderBy: { step: 'asc' } } },
      });
      if (!request) throw ApiError.notFound('Không tìm thấy đơn');

      const currentStepDef = request.steps.find((s) => s.step === request.currentStep + 1);
      if (action !== 'CANCEL' && currentStepDef && currentStepDef.approverId !== auth.userId) {
        throw ApiError.forbidden(
          `Bước hiện tại thuộc về ${currentStepDef.approverName ?? currentStepDef.approverType}, không phải bạn`,
        );
      }
      if (action === 'CANCEL' && request.employeeId !== auth.employeeId) {
        throw ApiError.forbidden('Chỉ người tạo đơn mới được huỷ');
      }

      const result = performApprovalAction({
        requestId: request.id,
        currentState: request.status as RequestState,
        action,
        actorId: auth.userId,
        actorName: auth.username,
        actorRole: auth.role,
        currentStep: request.currentStep,
        totalSteps: request.totalSteps,
        comment,
        ipAddress: req.clientIp,
        userAgent: req.headers['user-agent']?.slice(0, 255),
      });

      await prisma.$transaction(async (tx) => {
        await tx.leaveRequest.update({
          where: { id: request.id },
          data: {
            status: result.newState as never,
            currentStep: result.nextStep,
            decidedAt: result.isFinished ? new Date() : null,
            approvedBy: result.newState === 'APPROVED' ? auth.userId : null,
          },
        });
        if (currentStepDef) {
          await tx.approvalStep.update({
            where: { id: currentStepDef.id },
            data: {
              status: result.newState as never,
              action: action as never,
              comment,
              ipAddress: req.clientIp,
              userAgent: req.headers['user-agent']?.slice(0, 255),
              actedAt: new Date(),
            },
          });
        }
        // Mở bước kế tiếp
        const next = request.steps.find((s) => s.step === result.nextStep + 1);
        if (next && !result.isFinished) {
          await tx.approvalStep.update({ where: { id: next.id }, data: { status: 'PENDING_APPROVAL' } });
        }
        await tx.approvalAuditTrail.create({
          data: {
            requestId: request.id,
            actorId: result.audit.actorId,
            actorName: result.audit.actorName,
            actorRole: result.audit.actorRole as never,
            action: action as never,
            fromStatus: result.audit.fromStatus as never,
            toStatus: result.audit.toStatus as never,
            step: result.audit.step,
            comment,
            ipAddress: req.clientIp,
            userAgent: req.headers['user-agent']?.slice(0, 255),
          },
        });
      });

      res.json({
        status: result.newState,
        isFinished: result.isFinished,
        nextStep: result.nextStep,
        totalSteps: request.totalSteps,
      });
    });

  router.post('/leave-requests/:id/approve', requirePermission('leave.approve'), decide('APPROVE'));
  router.post('/leave-requests/:id/reject', requirePermission('leave.approve'), decide('REJECT'));
  router.post('/leave-requests/:id/return', requirePermission('leave.approve'), decide('RETURN'));
  router.post('/leave-requests/:id/cancel', requirePermission('leave.cancel', 'leave.create'), decide('CANCEL'));

  // --- VIỆC CẦN TÔI DUYỆT -------------------------------------------------------
  router.get(
    '/leave-requests/pending',
    requirePermission('leave.approve'),
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const auth = req.auth!;
      const rows = await prisma.approvalStep.findMany({
        where: {
          approverId: auth.userId,
          status: 'PENDING_APPROVAL',
        },
        include: {
          request: {
            include: { employee: { select: { code: true, fullName: true, department: { select: { name: true } } } } },
          },
        },
        orderBy: { createdAt: 'asc' },
      });
      res.json({ count: rows.length, data: rows });
    }),
  );

  // --- NHẬT KÝ VẾT PHÊ DUYỆT --------------------------------------------------------
  router.get(
    '/leave-requests/:id/trail',
    requirePermission('leave.approve', 'self.read'),
    asyncHandler(async (req, res) => {
      const prisma = getPrisma();
      const trail = await prisma.approvalAuditTrail.findMany({
        where: { requestId: String(req.params.id) },
        orderBy: { createdAt: 'asc' },
      });
      res.json({ count: trail.length, data: trail });
    }),
  );

  return router;
}
