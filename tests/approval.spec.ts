/**
 * Kiểm thử LUỒNG PHÊ DUYỆT: state machine, ma trận người duyệt, audit trail.
 */
import { describe, expect, it } from 'vitest';

import {
  allowedActions,
  BUSINESS_TRIP_MATRIX,
  canTransition,
  evaluateCondition,
  extractClientIp,
  isFinalState,
  isValidIp,
  LEAVE_APPROVAL_MATRIX,
  performApprovalAction,
  REGULARIZATION_MATRIX,
  resolveApprovalChain,
  transition,
  WorkflowError,
  type ApproverResolver,
  type WorkflowContext,
} from '../src/domain/approval.js';

// ---------------------------------------------------------------------------
// Resolver giả lập cây tổ chức
// ---------------------------------------------------------------------------
function makeResolver(): ApproverResolver {
  const people: Record<string, { userId: string; name: string } | null> = {
    manager: { userId: 'u-manager', name: 'Nguyễn Văn Quản Lý' },
    depHead: { userId: 'u-dephead', name: 'Trần Thị Trưởng Phòng' },
    branchHead: { userId: 'u-branch', name: 'Lê Giám Đốc Chi Nhánh' },
    hr: { userId: 'u-hr', name: 'Phạm HR Head' },
    ceo: { userId: 'u-ceo', name: 'Võ Tổng Giám Đốc' },
    accountant: { userId: 'u-ktt', name: 'Đặng Kế Toán Trưởng' },
    missing: null,
  };
  return {
    getDirectManager: async () => people.manager!,
    getDepartmentHead: async () => people.depHead!,
    getBranchHead: async () => people.branchHead!,
    getByRole: async (role) => {
      if (role === 'HR_HEAD' || role === 'HR_ADMIN') return people.hr!;
      if (role === 'CEO') return people.ceo!;
      if (role === 'CHIEF_ACCOUNTANT') return people.accountant!;
      return people.missing;
    },
    getUser: async (id) => ({ userId: id, name: `User ${id}` }),
  };
}

describe('State machine — bảng chuyển trạng thái', () => {
  it('DRAFT → submit → PENDING_APPROVAL', () => {
    expect(transition('DRAFT', 'SUBMIT')).toBe('PENDING_APPROVAL');
  });

  it('DRAFT không thể APPROVE trực tiếp', () => {
    expect(canTransition('DRAFT', 'APPROVE')).toBe(false);
    expect(() => transition('DRAFT', 'APPROVE')).toThrow(WorkflowError);
  });

  it('APPROVE ở bước giữa vẫn ở PENDING_APPROVAL, bước cuối mới APPROVED', () => {
    expect(transition('PENDING_APPROVAL', 'APPROVE', { currentStep: 0, totalSteps: 3 })).toBe(
      'PENDING_APPROVAL',
    );
    expect(transition('PENDING_APPROVAL', 'APPROVE', { currentStep: 1, totalSteps: 3 })).toBe(
      'PENDING_APPROVAL',
    );
    expect(transition('PENDING_APPROVAL', 'APPROVE', { currentStep: 2, totalSteps: 3 })).toBe(
      'APPROVED',
    );
  });

  it('REJECT / RETURN / CANCEL từ PENDING_APPROVAL', () => {
    expect(transition('PENDING_APPROVAL', 'REJECT')).toBe('REJECTED');
    expect(transition('PENDING_APPROVAL', 'RETURN')).toBe('RETURNED');
    expect(transition('PENDING_APPROVAL', 'CANCEL')).toBe('CANCELLED');
  });

  it('RETURNED có thể submit lại', () => {
    expect(transition('RETURNED', 'SUBMIT')).toBe('PENDING_APPROVAL');
  });

  it('trạng thái cuối không cho phép hành động nào', () => {
    for (const s of ['APPROVED', 'REJECTED', 'CANCELLED'] as const) {
      expect(isFinalState(s)).toBe(true);
      expect(allowedActions(s)).toHaveLength(0);
    }
  });

  it('thông báo lỗi liệt kê hành động hợp lệ', () => {
    try {
      transition('APPROVED', 'CANCEL');
      expect.unreachable('phải ném lỗi');
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowError);
      expect((e as WorkflowError).code).toBe('ILLEGAL_TRANSITION');
      expect((e as Error).message).toContain('không có — đơn đã kết thúc');
    }
  });
});

describe('Đánh giá điều kiện ma trận duyệt', () => {
  it('toán tử số', () => {
    const ctx: WorkflowContext = { days: 3 };
    expect(evaluateCondition({ field: 'days', op: '>=', value: 3 }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'days', op: '>', value: 3 }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'days', op: '<', value: 2 }, ctx)).toBe(false);
    expect(evaluateCondition({ field: 'days', op: '<=', value: 3 }, ctx)).toBe(true);
  });

  it('toán tử in / nin', () => {
    const ctx: WorkflowContext = { type: 'UNPAID_LEAVE' };
    expect(evaluateCondition({ field: 'type', op: 'in', value: ['UNPAID_LEAVE', 'SICK_LEAVE'] }, ctx)).toBe(true);
    expect(evaluateCondition({ field: 'type', op: 'nin', value: ['ANNUAL_LEAVE'] }, ctx)).toBe(true);
  });

  it('bắt lỗi toán tử lạ', () => {
    expect(() =>
      evaluateCondition({ field: 'days', op: '~=' as never, value: 1 }, { days: 1 }),
    ).toThrow(WorkflowError);
  });
});

describe('resolveApprovalChain — phân giải chuỗi người duyệt', () => {
  const workflow = { code: 'WF_LEAVE', name: 'Duyệt nghỉ phép', steps: LEAVE_APPROVAL_MATRIX };

  it('nghỉ 1 ngày: CHỈ cần Quản lý trực tiếp', async () => {
    const r = await resolveApprovalChain(
      workflow,
      { requesterEmployeeId: 'e1', context: { days: 1 } },
      makeResolver(),
    );
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]!.approverType).toBe('DIRECT_MANAGER');
    expect(r.skipped).toHaveLength(3); // DEPARTMENT_HEAD + HR_HEAD + CEO bị bỏ qua
    expect(r.skipped.map((x) => x.step).sort()).toEqual([2, 3, 4]);
    expect(r.errors).toHaveLength(0);
  });

  it('nghỉ 2 ngày: Quản lý trực tiếp + Trưởng phòng', async () => {
    const r = await resolveApprovalChain(
      workflow,
      { requesterEmployeeId: 'e1', context: { days: 2 } },
      makeResolver(),
    );
    expect(r.steps.map((s) => s.approverType)).toEqual(['DIRECT_MANAGER', 'DEPARTMENT_HEAD']);
  });

  it('nghỉ 3 ngày trở lên: lên tới Tổng giám đốc (4 cấp)', async () => {
    for (const days of [3, 5, 10]) {
      const r = await resolveApprovalChain(
        workflow,
        { requesterEmployeeId: 'e1', context: { days } },
        makeResolver(),
      );
      expect(r.steps.map((s) => s.approverType), `days=${days}`).toEqual([
        'DIRECT_MANAGER',
        'DEPARTMENT_HEAD',
        'HR_HEAD',
        'CEO',
      ]);
      // step được đánh số lại liên tục sau khi lọc
      expect(r.steps.map((s) => s.step), `days=${days}`).toEqual([1, 2, 3, 4]);
    }
  });

  it('bỏ qua bước trùng người duyệt', async () => {
    const resolver = makeResolver();
    // Quản lý trực tiếp trùng Trưởng phòng
    resolver.getDepartmentHead = async () => ({ userId: 'u-manager', name: 'Nguyễn Văn Quản Lý' });
    const r = await resolveApprovalChain(
      workflow,
      { requesterEmployeeId: 'e1', context: { days: 2 } },
      resolver,
    );
    expect(r.steps).toHaveLength(1);
    expect(r.skipped.some((s) => s.reason.includes('Trùng người duyệt'))).toBe(true);
  });

  it('không tìm thấy người duyệt → ghi vào errors, không âm thầm bỏ qua', async () => {
    const resolver = makeResolver();
    resolver.getByRole = async () => null;
    const r = await resolveApprovalChain(
      workflow,
      { requesterEmployeeId: 'e1', context: { days: 5 } },
      resolver,
    );
    expect(r.errors.some((e) => e.includes('không tìm thấy người duyệt'))).toBe(true);
    expect(r.steps.map((s) => s.approverType)).toEqual(['DIRECT_MANAGER', 'DEPARTMENT_HEAD']);
  });

  it('thiếu approverRole với approverType=ROLE → lỗi cấu hình', async () => {
    const r = await resolveApprovalChain(
      {
        code: 'BAD',
        name: 'Sai',
        steps: [{ step: 1, approverType: 'ROLE' }],
      },
      { requesterEmployeeId: 'e1', context: {} },
      makeResolver(),
    );
    expect(r.errors[0]).toContain('thiếu approverRole');
  });

  it('SLA tạo dueAt', async () => {
    const now = new Date('2026-03-05T08:00:00Z');
    const r = await resolveApprovalChain(
      workflow,
      { requesterEmployeeId: 'e1', context: { days: 1 }, now },
      makeResolver(),
    );
    expect(r.steps[0]!.dueAt?.toISOString()).toBe('2026-03-06T08:00:00.000Z'); // +24h
  });

  it('đơn công tác phân cấp theo số tiền', async () => {
    const wf = { code: 'WF_TRIP', name: 'Công tác', steps: BUSINESS_TRIP_MATRIX };
    const small = await resolveApprovalChain(
      wf,
      { requesterEmployeeId: 'e1', context: { amountVnd: 2_000_000 } },
      makeResolver(),
    );
    expect(small.steps.map((s) => s.approverType)).toEqual(['DIRECT_MANAGER', 'DEPARTMENT_HEAD']);

    const mid = await resolveApprovalChain(
      wf,
      { requesterEmployeeId: 'e1', context: { amountVnd: 10_000_000 } },
      makeResolver(),
    );
    expect(mid.steps.map((s) => s.approverType)).toEqual([
      'DIRECT_MANAGER',
      'DEPARTMENT_HEAD',
      'CHIEF_ACCOUNTANT',
    ]);

    const big = await resolveApprovalChain(
      wf,
      { requesterEmployeeId: 'e1', context: { amountVnd: 50_000_000 } },
      makeResolver(),
    );
    expect(big.steps.map((s) => s.approverType)).toEqual([
      'DIRECT_MANAGER',
      'DEPARTMENT_HEAD',
      'CHIEF_ACCOUNTANT',
      'CEO',
    ]);
  });

  it('ma trận đơn giải trình có 2 cấp', () => {
    expect(REGULARIZATION_MATRIX).toHaveLength(2);
    expect(REGULARIZATION_MATRIX[1]!.approverType).toBe('HR_HEAD');
  });
});

describe('performApprovalAction — thực hiện duyệt + audit trail', () => {
  const base = {
    requestId: 'req-1',
    actorId: 'u-1',
    actorName: 'Trần A',
    actorRole: 'DEPARTMENT_HEAD',
    currentStep: 0,
    totalSteps: 2,
    ipAddress: '113.161.12.34',
    userAgent: 'Mozilla/5.0',
  };

  it('duyệt bước 1/2 → vẫn PENDING, nextStep = 1', () => {
    const r = performApprovalAction({ ...base, currentState: 'PENDING_APPROVAL', action: 'APPROVE' });
    expect(r.newState).toBe('PENDING_APPROVAL');
    expect(r.nextStep).toBe(1);
    expect(r.isFinished).toBe(false);
  });

  it('duyệt bước 2/2 → APPROVED, kết thúc', () => {
    const r = performApprovalAction({
      ...base,
      currentState: 'PENDING_APPROVAL',
      action: 'APPROVE',
      currentStep: 1,
    });
    expect(r.newState).toBe('APPROVED');
    expect(r.isFinished).toBe(true);
  });

  it('audit trail ghi đủ User, thời gian, hành động, ghi chú, IP', () => {
    const now = new Date('2026-03-05T02:00:00Z');
    const r = performApprovalAction({
      ...base,
      currentState: 'PENDING_APPROVAL',
      action: 'REJECT',
      comment: 'Không đủ ngày phép còn lại',
      now,
    });
    expect(r.audit.actorId).toBe('u-1');
    expect(r.audit.action).toBe('REJECT');
    expect(r.audit.fromStatus).toBe('PENDING_APPROVAL');
    expect(r.audit.toStatus).toBe('REJECTED');
    expect(r.audit.comment).toBe('Không đủ ngày phép còn lại');
    expect(r.audit.ipAddress).toBe('113.161.12.34');
    expect(r.audit.at.toISOString()).toBe('2026-03-05T02:00:00.000Z');
  });

  it('từ chối IP không hợp lệ', () => {
    expect(() =>
      performApprovalAction({ ...base, currentState: 'PENDING_APPROVAL', action: 'APPROVE', ipAddress: '999.1.1.1' }),
    ).toThrow(WorkflowError);
  });

  it('duyệt/từ chối bắt buộc phải có người thực hiện', () => {
    expect(() =>
      performApprovalAction({ ...base, currentState: 'PENDING_APPROVAL', action: 'APPROVE', actorId: null }),
    ).toThrow(/người thực hiện/);
  });
});

describe('extractClientIp / isValidIp', () => {
  it('lấy IP đầu tiên từ X-Forwarded-For', () => {
    expect(extractClientIp({ 'x-forwarded-for': '113.161.12.34, 10.0.0.1' })).toBe('113.161.12.34');
    expect(extractClientIp({ 'X-Forwarded-For': ['1.2.3.4, 5.6.7.8'] })).toBe('1.2.3.4');
  });
  it('fallback về x-real-ip rồi socket', () => {
    expect(extractClientIp({ 'x-real-ip': '8.8.8.8' })).toBe('8.8.8.8');
    expect(extractClientIp({}, '172.16.0.1')).toBe('172.16.0.1');
  });
  it('không hợp lệ → 0.0.0.0', () => {
    expect(extractClientIp({ 'x-forwarded-for': 'garbage' })).toBe('0.0.0.0');
  });
  it('isValidIp bắt octet > 255', () => {
    expect(isValidIp('256.1.1.1')).toBe(false);
    expect(isValidIp('192.168.0.1')).toBe(true);
    expect(isValidIp('2001:db8::1')).toBe(true);
    expect(isValidIp(null)).toBe(false);
  });
});
