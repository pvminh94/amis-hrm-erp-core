/**
 * ============================================================================
 * APPROVAL WORKFLOW ENGINE — State Machine + Ma trận người duyệt đa cấp
 * ============================================================================
 *
 * Vòng đời đơn từ:
 *
 *   DRAFT ──submit──> SUBMITTED ──auto-route──> PENDING_APPROVAL ──┬──> APPROVED
 *     │                    │                        │  ▲           ├──> REJECTED
 *     │                    │                        │  └─ return ──┤
 *     └──────cancel────────┴────────cancel──────────┴─────────────┴──> CANCELLED
 *
 * Ma trận người duyệt (định nghĩa bằng JSON trong WorkflowDefinition.steps):
 *
 *   [
 *     { "step": 1, "approverType": "DIRECT_MANAGER" },
 *     { "step": 2, "approverType": "DEPARTMENT_HEAD" },
 *     { "step": 3, "approverType": "ROLE", "approverRole": "HR_ADMIN" },
 *     { "step": 4, "approverType": "ROLE", "approverRole": "CEO",
 *       "when": { "field": "days", "op": ">=", "value": 3 } }
 *   ]
 *
 *   → Đơn nghỉ 1 ngày: chỉ cần bước 1 (Quản lý trực tiếp)
 *   → Đơn nghỉ 3 ngày: bước 1 → 2 → 3 → 4 (lên tới Tổng giám đốc)
 *
 * Mỗi hành động được ghi vào ApprovalAuditTrail (bất biến): User ID, thời gian,
 * hành động, ghi chú, địa chỉ IP, user-agent, trạng thái trước/sau.
 *
 * Toàn bộ THUẦN — không phụ thuộc DB, kiểm thử được 100%.
 */

export type RequestState =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'RETURNED';

export type WorkflowAction =
  | 'SUBMIT'
  | 'APPROVE'
  | 'REJECT'
  | 'RETURN'
  | 'CANCEL'
  | 'REASSIGN'
  | 'AUTO_APPROVE'
  | 'ESCALATE';

export type ConditionOperator = '>' | '>=' | '<' | '<=' | '==' | '!=' | 'in' | 'nin';

export interface ApprovalCondition {
  /** Trường trên đơn: days | hours | type | isPaid | amount | amountVnd ... */
  field: string;
  op: ConditionOperator;
  value: number | string | boolean | Array<string | number>;
}

export type ApproverType =
  | 'DIRECT_MANAGER'
  | 'DEPARTMENT_HEAD'
  | 'BRANCH_HEAD'
  | 'HR_HEAD'
  | 'CHIEF_ACCOUNTANT'
  | 'CEO'
  | 'ROLE'
  | 'USER';

export interface ApprovalStepDef {
  step: number;
  approverType: ApproverType;
  /** Dùng khi approverType = 'ROLE' */
  approverRole?: string;
  /** Dùng khi approverType = 'USER' */
  approverUserId?: string;
  /** Điều kiện kích hoạt bước này */
  when?: ApprovalCondition;
  /** Cho phép bỏ qua nếu người duyệt trùng với người đã duyệt ở bước trước */
  skipIfSameApprover?: boolean;
  /** Hạn xử lý (giờ) để escalation */
  slaHours?: number;
}

export interface WorkflowDefinitionLike {
  code: string;
  name: string;
  steps: ApprovalStepDef[];
}

/** Ngữ cảnh để đánh giá điều kiện và phân giải người duyệt */
export interface WorkflowContext {
  /** Số ngày nghỉ/công tác */
  days?: number;
  hours?: number;
  type?: string;
  isPaid?: boolean;
  amount?: number;
  amountVnd?: number;
  [key: string]: unknown;
}

/** Người duyệt đã được phân giải cụ thể */
export interface ResolvedApprover {
  step: number;
  approverType: ApproverType;
  approverRole?: string;
  userId?: string;
  userName: string;
  dueAt?: Date;
}

export interface RouteResult {
  steps: ResolvedApprover[];
  skipped: Array<{ step: number; reason: string }>;
  errors: string[];
}

// ---------------------------------------------------------------------------
// STATE MACHINE
// ---------------------------------------------------------------------------

/** Bảng chuyển trạng thái hợp lệ. Mọi chuyển đổi ngoài bảng này bị từ chối. */
export const STATE_TRANSITIONS: Record<RequestState, Partial<Record<WorkflowAction, RequestState>>> = {
  DRAFT: {
    SUBMIT: 'PENDING_APPROVAL',
    CANCEL: 'CANCELLED',
  },
  SUBMITTED: {
    APPROVE: 'PENDING_APPROVAL',
    AUTO_APPROVE: 'APPROVED',
    CANCEL: 'CANCELLED',
    REJECT: 'REJECTED',
  },
  PENDING_APPROVAL: {
    APPROVE: 'PENDING_APPROVAL', // sẽ được ghi đè thành APPROVED nếu là bước cuối
    REJECT: 'REJECTED',
    RETURN: 'RETURNED',
    CANCEL: 'CANCELLED',
    ESCALATE: 'PENDING_APPROVAL',
    REASSIGN: 'PENDING_APPROVAL',
  },
  RETURNED: {
    SUBMIT: 'PENDING_APPROVAL',
    CANCEL: 'CANCELLED',
  },
  APPROVED: {},
  REJECTED: {},
  CANCELLED: {},
};

const FINAL_STATES: ReadonlySet<RequestState> = new Set(['APPROVED', 'REJECTED', 'CANCELLED']);

export class WorkflowError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

export function isFinalState(state: RequestState): boolean {
  return FINAL_STATES.has(state);
}

export function canTransition(state: RequestState, action: WorkflowAction): boolean {
  return STATE_TRANSITIONS[state]?.[action] !== undefined;
}

export function allowedActions(state: RequestState): WorkflowAction[] {
  return Object.keys(STATE_TRANSITIONS[state] ?? {}) as WorkflowAction[];
}

/**
 * Thực hiện một bước chuyển trạng thái. Ném WorkflowError nếu không hợp lệ.
 */
export function transition(
  current: RequestState,
  action: WorkflowAction,
  ctx: { currentStep?: number; totalSteps?: number } = {},
): RequestState {
  const next = STATE_TRANSITIONS[current]?.[action];
  if (next === undefined) {
    throw new WorkflowError(
      'ILLEGAL_TRANSITION',
      `Không thể thực hiện "${action}" ở trạng thái "${current}". Các hành động hợp lệ: ${
        allowedActions(current).join(', ') || '(không có — đơn đã kết thúc)'
      }`,
    );
  }
  // Với APPROVE: chỉ chuyển sang APPROVED khi đã duyệt hết các bước
  if (action === 'APPROVE' && current === 'PENDING_APPROVAL') {
    const { currentStep = 0, totalSteps = 1 } = ctx;
    return currentStep + 1 >= totalSteps ? 'APPROVED' : 'PENDING_APPROVAL';
  }
  return next;
}

// ---------------------------------------------------------------------------
// ĐÁNH GIÁ ĐIỀU KIỆN
// ---------------------------------------------------------------------------

export function evaluateCondition(cond: ApprovalCondition, ctx: WorkflowContext): boolean {
  const raw = ctx[cond.field];
  const actual = typeof raw === 'number' ? raw : (raw as string | boolean | undefined);

  switch (cond.op) {
    case '>':
      return Number(actual) > Number(cond.value);
    case '>=':
      return Number(actual) >= Number(cond.value);
    case '<':
      return Number(actual) < Number(cond.value);
    case '<=':
      return Number(actual) <= Number(cond.value);
    case '==':
      // so sánh lỏng về kiểu: 3 == "3" == true
      return String(actual) === String(cond.value);
    case '!=':
      return String(actual) !== String(cond.value);
    case 'in': {
      const list = Array.isArray(cond.value) ? cond.value : [cond.value];
      return list.some((v) => String(v) === String(actual));
    }
    case 'nin': {
      const list = Array.isArray(cond.value) ? cond.value : [cond.value];
      return !list.some((v) => String(v) === String(actual));
    }
    default:
      throw new WorkflowError('UNKNOWN_OPERATOR', `Toán tử điều kiện không hỗ trợ: ${cond.op}`);
  }
}

/** Một bước có được kích hoạt với ngữ cảnh hiện tại không */
export function isStepActive(stepDef: ApprovalStepDef, ctx: WorkflowContext): boolean {
  if (!stepDef.when) return true;
  return evaluateCondition(stepDef.when, ctx);
}

// ---------------------------------------------------------------------------
// PHÂN GIẢI NGƯỜI DUYỆT
// ---------------------------------------------------------------------------

/** Nhà cung cấp thông tin tổ chức — application layer implement bằng Prisma */
export interface ApproverResolver {
  /** Quản lý trực tiếp của người làm đơn */
  getDirectManager(employeeId: string): Promise<{ userId: string; name: string } | null>;
  /** Trưởng phòng ban */
  getDepartmentHead(employeeId: string): Promise<{ userId: string; name: string } | null>;
  /** Trưởng chi nhánh */
  getBranchHead(employeeId: string): Promise<{ userId: string; name: string } | null>;
  /** Người giữ một vai trò (HR_HEAD, CEO, CHIEF_ACCOUNTANT...) */
  getByRole(role: string, employeeId: string): Promise<{ userId: string; name: string } | null>;
  /** Một người dùng cụ thể */
  getUser(userId: string): Promise<{ userId: string; name: string } | null>;
}

export interface RouteInput {
  requesterEmployeeId: string;
  context: WorkflowContext;
  now?: Date;
}

/**
 * Phân giải chuỗi người duyệt cho một đơn, dựa trên định nghĩa workflow.
 *
 * - Bỏ qua các bước có điều kiện `when` không thoả.
 * - Bỏ qua bước trùng người duyệt với bước trước nếu `skipIfSameApprover`.
 * - Ghi nhận lỗi (không tìm thấy người duyệt) vào `errors` để HR xử lý,
 *   KHÔNG âm thầm bỏ qua bước.
 */
export async function resolveApprovalChain(
  workflow: WorkflowDefinitionLike,
  input: RouteInput,
  resolver: ApproverResolver,
): Promise<RouteResult> {
  const steps: ResolvedApprover[] = [];
  const skipped: RouteResult['skipped'] = [];
  const errors: string[] = [];
  const now = input.now ?? new Date();

  const sorted = [...workflow.steps].sort((a, b) => a.step - b.step);

  for (const def of sorted) {
    if (!isStepActive(def, input.context)) {
      skipped.push({
        step: def.step,
        reason: `Điều kiện không thoả: ${JSON.stringify(def.when)}`,
      });
      continue;
    }

    let person: { userId: string; name: string } | null = null;
    try {
      switch (def.approverType) {
        case 'DIRECT_MANAGER':
          person = await resolver.getDirectManager(input.requesterEmployeeId);
          break;
        case 'DEPARTMENT_HEAD':
          person = await resolver.getDepartmentHead(input.requesterEmployeeId);
          break;
        case 'BRANCH_HEAD':
          person = await resolver.getBranchHead(input.requesterEmployeeId);
          break;
        case 'HR_HEAD':
        case 'CHIEF_ACCOUNTANT':
        case 'CEO':
          person = await resolver.getByRole(def.approverType, input.requesterEmployeeId);
          break;
        case 'ROLE':
          if (!def.approverRole) {
            errors.push(`Bước ${def.step}: approverType=ROLE nhưng thiếu approverRole`);
            break;
          }
          person = await resolver.getByRole(def.approverRole, input.requesterEmployeeId);
          break;
        case 'USER':
          if (!def.approverUserId) {
            errors.push(`Bước ${def.step}: approverType=USER nhưng thiếu approverUserId`);
            break;
          }
          person = await resolver.getUser(def.approverUserId);
          break;
        default:
          errors.push(`Bước ${def.step}: approverType không xác định "${def.approverType}"`);
      }
    } catch (e) {
      errors.push(`Bước ${def.step}: lỗi phân giải người duyệt — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (!person) {
      errors.push(
        `Bước ${def.step} (${def.approverType}): không tìm thấy người duyệt cho nhân viên ${input.requesterEmployeeId}`,
      );
      continue;
    }

    // Bỏ qua nếu trùng người duyệt bước trước
    const prev = steps[steps.length - 1];
    if (def.skipIfSameApprover !== false && prev && prev.userId === person.userId) {
      skipped.push({ step: def.step, reason: `Trùng người duyệt với bước ${prev.step} (${person.name})` });
      continue;
    }

    steps.push({
      step: steps.length + 1,
      approverType: def.approverType,
      approverRole: def.approverRole,
      userId: person.userId,
      userName: person.name,
      dueAt: def.slaHours ? new Date(now.getTime() + def.slaHours * 3_600_000) : undefined,
    });
  }

  return { steps, skipped, errors };
}

// ---------------------------------------------------------------------------
// MA TRẬN DUYỆT THEO SỐ NGÀY NGHỈ (quy tắc nghiệp vụ phổ biến tại VN)
// ---------------------------------------------------------------------------

/**
 * Định nghĩa sẵn: ma trận duyệt đơn nghỉ phép theo số ngày.
 *   < 2 ngày  : Quản lý trực tiếp
 *   2 ngày    : + Trưởng phòng
 *   >= 3 ngày : + Trưởng phòng Nhân sự + Tổng giám đốc
 */
export const LEAVE_APPROVAL_MATRIX: ApprovalStepDef[] = [
  // Nghỉ dưới 2 ngày: CHỈ cần Quản lý trực tiếp
  { step: 1, approverType: 'DIRECT_MANAGER', slaHours: 24 },
  // Từ 2 ngày: thêm Trưởng phòng
  { step: 2, approverType: 'DEPARTMENT_HEAD', slaHours: 24, when: { field: 'days', op: '>=', value: 2 } },
  // Từ 3 ngày: thêm Trưởng phòng Nhân sự
  { step: 3, approverType: 'HR_HEAD', slaHours: 48, when: { field: 'days', op: '>=', value: 3 } },
  // Từ 3 ngày: lên tới Tổng giám đốc
  { step: 4, approverType: 'CEO', slaHours: 48, when: { field: 'days', op: '>=', value: 3 } },
];

/** Định nghĩa sẵn: đơn giải trình (regularization) — HR duyệt */
export const REGULARIZATION_MATRIX: ApprovalStepDef[] = [
  { step: 1, approverType: 'DIRECT_MANAGER', slaHours: 24 },
  { step: 2, approverType: 'HR_HEAD', slaHours: 48 },
];

/** Định nghĩa sẵn: đơn công tác */
export const BUSINESS_TRIP_MATRIX: ApprovalStepDef[] = [
  { step: 1, approverType: 'DIRECT_MANAGER', slaHours: 24 },
  { step: 2, approverType: 'DEPARTMENT_HEAD', slaHours: 24 },
  {
    step: 3,
    approverType: 'CHIEF_ACCOUNTANT',
    slaHours: 48,
    when: { field: 'amountVnd', op: '>', value: 5_000_000 },
  },
  { step: 4, approverType: 'CEO', slaHours: 48, when: { field: 'amountVnd', op: '>', value: 20_000_000 } },
];

// ---------------------------------------------------------------------------
// AUDIT TRAIL
// ---------------------------------------------------------------------------

export interface AuditEntry {
  requestId: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  action: WorkflowAction;
  fromStatus: RequestState;
  toStatus: RequestState;
  step: number | null;
  comment: string | null;
  ipAddress: string;
  userAgent: string | null;
  at: Date;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

/** Kiểm tra IP hợp lệ — chống ghi rác vào audit trail */
export function isValidIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  if (IPV4_RE.test(ip)) {
    return ip.split('.').every((p) => Number(p) >= 0 && Number(p) <= 255);
  }
  return ip.length <= 45 && IPV6_RE.test(ip);
}

/** Lấy IP thật từ header X-Forwarded-For (giá trị đầu tiên = client gốc) */
export function extractClientIp(headers: Record<string, string | string[] | undefined>, socketRemote?: string): string {
  const xff = headers['x-forwarded-for'] ?? headers['X-Forwarded-For'];
  if (typeof xff === 'string' && xff.trim() !== '') {
    const first = xff.split(',')[0]!.trim();
    if (isValidIp(first)) return first;
  }
  if (typeof xff === 'object' && Array.isArray(xff) && xff.length > 0) {
    const first = String(xff[0]).split(',')[0]!.trim();
    if (isValidIp(first)) return first;
  }
  const real = headers['x-real-ip'] ?? headers['X-Real-IP'];
  if (typeof real === 'string' && isValidIp(real)) return real;
  return socketRemote && isValidIp(socketRemote) ? socketRemote : '0.0.0.0';
}

export interface ActionInput {
  requestId: string;
  currentState: RequestState;
  action: WorkflowAction;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  currentStep: number;
  totalSteps: number;
  comment?: string | null;
  ipAddress: string;
  userAgent?: string | null;
  now?: Date;
}

export interface ActionResult {
  newState: RequestState;
  nextStep: number;
  isFinished: boolean;
  audit: AuditEntry;
}

/**
 * Thực hiện một hành động duyệt và sinh bản ghi audit trail bất biến.
 */
export function performApprovalAction(input: ActionInput): ActionResult {
  if (!isValidIp(input.ipAddress)) {
    throw new WorkflowError('INVALID_IP', `Địa chỉ IP không hợp lệ: ${input.ipAddress}`);
  }
  if (input.action === 'APPROVE' || input.action === 'REJECT' || input.action === 'RETURN') {
    if (!input.actorId) {
      throw new WorkflowError('ACTOR_REQUIRED', 'Hành động duyệt bắt buộc phải có người thực hiện');
    }
  }

  const from = input.currentState;
  const to = transition(from, input.action, {
    currentStep: input.currentStep,
    totalSteps: input.totalSteps,
  });

  let nextStep = input.currentStep;
  if (input.action === 'APPROVE' && to === 'PENDING_APPROVAL') nextStep = input.currentStep + 1;
  if (input.action === 'REJECT' || input.action === 'CANCEL') nextStep = input.currentStep;

  const audit: AuditEntry = {
    requestId: input.requestId,
    actorId: input.actorId,
    actorName: input.actorName,
    actorRole: input.actorRole,
    action: input.action,
    fromStatus: from,
    toStatus: to,
    step: input.action === 'APPROVE' ? input.currentStep + 1 : input.currentStep,
    comment: input.comment ?? null,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent ?? null,
    at: input.now ?? new Date(),
  };

  return { newState: to, nextStep, isFinished: isFinalState(to), audit };
}
