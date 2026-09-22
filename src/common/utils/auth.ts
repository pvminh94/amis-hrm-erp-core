/**
 * ============================================================================
 * XÁC THỰC & PHÂN QUYỀN — JWT Access + HttpOnly Refresh, RBAC + Data Scope
 * ============================================================================
 */

import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

import type { DataScope, UserRole } from '@prisma/client';

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

export interface AccessTokenPayload {
  sub: string; // userId
  username: string;
  role: UserRole;
  dataScope: DataScope;
  scopeRefs: string[];
  employeeId?: string;
  typ: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  familyId: string;
  typ: 'refresh';
}

export function signAccessToken(
  payload: Omit<AccessTokenPayload, 'typ'>,
  secret: string,
  ttlSeconds: number,
): string {
  return jwt.sign({ ...payload, typ: 'access' } as object, secret, {
    expiresIn: ttlSeconds,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string, secret: string): AccessTokenPayload {
  const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as AccessTokenPayload;
  if (decoded.typ !== 'access') throw new Error('Token không phải access token');
  return decoded;
}

/** Sinh cặp refresh token: giá trị trả về + hash để lưu DB */
export function signRefreshToken(
  userId: string,
  familyId: string,
  secret: string,
  ttlSeconds: number,
): { token: string; tokenHash: string } {
  const token = jwt.sign({ sub: userId, familyId, typ: 'refresh' } as object, secret, {
    expiresIn: ttlSeconds,
    algorithm: 'HS256',
  });
  return { token, tokenHash: hashToken(token) };
}

export function verifyRefreshToken(token: string, secret: string): RefreshTokenPayload {
  const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as RefreshTokenPayload;
  if (decoded.typ !== 'refresh') throw new Error('Token không phải refresh token');
  return decoded;
}

/**
 * SHA-256 một chuỗi (dùng để lưu refresh token dạng hash, không lưu plaintext).
 *
 * LƯU Ý — LỖI ĐÃ TỪNG XẢY RA Ở ĐÂY: hàm này từng gọi `require('node:crypto')`
 * "cho tiện khỏi import". Dự án chạy `"type": "module"` + `module: ESNext`,
 * tức output là ESM — mà ESM KHÔNG có `require`. Kết quả:
 *   ReferenceError: require is not defined
 * và nó nổ đúng lúc login (signRefreshToken -> hashToken), khiến API trả 500
 * trong khi app vẫn khởi động, migrate, seed và /health bình thường.
 *
 * Ba lý do lỗi này lọt lưới:
 *   1. tsc KHÔNG báo — @types/node khai báo `require` toàn cục, và
 *      moduleResolution: bundler không kiểm tra ranh giới ESM/CJS.
 *   2. Unit test chạy qua Vitest/Vite, môi trường có sẵn shim `require`.
 *   3. smoke.mjs test bcrypt + AES nhưng chưa từng chạm tới hashToken.
 * => Bài học: import tĩnh ở đầu file. Đừng dùng require() trong project ESM.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function randomTokenId(): string {
  return randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

/**
 * Ma trận quyền theo vai trò. Dùng mã quyền dạng `module.resource.action`.
 * Ký tự '*' ở bất kỳ cấp nào là wildcard.
 */
export const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  SUPER_ADMIN: ['*'],
  HR_ADMIN: [
    'org.*',
    'employee.*',
    'attendance.*',
    'leave.*',
    'payroll.run.create',
    'payroll.run.lock',
    'payroll.payslip.*',
    'workflow.*',
    'report.*',
  ],
  HR_STAFF: [
    'employee.read',
    'attendance.read',
    'attendance.write',
    'leave.approve',
    'leave.read',
    'payroll.run.create',
    'report.attendance',
  ],
  DEPARTMENT_HEAD: ['employee.read', 'attendance.read', 'leave.approve', 'report.attendance'],
  DIRECT_LINE_MANAGER: ['employee.read', 'attendance.read', 'leave.approve'],
  ACCOUNTANT: ['payroll.read', 'payroll.run.lock', 'journal.read', 'journal.post', 'payment.*'],
  CHIEF_ACCOUNTANT: ['payroll.*', 'journal.*', 'payment.*', 'report.*'],
  CEO: ['payroll.run.approve', 'payroll.read', 'report.*', 'leave.approve'],
  EMPLOYEE: ['self.read', 'self.attendance', 'self.payslip', 'leave.create', 'leave.cancel'],
};

/** Kiểm tra một vai trò có quyền cụ thể không (hỗ trợ wildcard từng cấp) */
export function hasPermission(role: UserRole, required: string): boolean {
  const granted = ROLE_PERMISSIONS[role];
  if (!granted) return false;
  if (granted.includes('*')) return true;

  const parts = required.split('.');
  return granted.some((g) => {
    const gp = g.split('.');
    for (let i = 0; i < gp.length; i += 1) {
      const segment = gp[i]!;
      if (segment === '*') return true; // wildcard khớp toàn bộ phần còn lại
      if (segment !== parts[i]) return false;
    }
    return gp.length === parts.length;
  });
}

export function hasAnyPermission(role: UserRole, required: string[]): boolean {
  return required.some((r) => hasPermission(role, r));
}

// ---------------------------------------------------------------------------
// DATA SCOPE — lọc dữ liệu theo phạm vi
// ---------------------------------------------------------------------------

export interface ScopeContext {
  userId: string;
  role: UserRole;
  dataScope: DataScope;
  scopeRefs: string[];
  employeeId?: string;
}

/**
 * Sinh điều kiện `where` của Prisma theo phạm vi dữ liệu.
 *   ALL_COMPANY : không lọc
 *   BRANCH      : department nằm trong cây của các chi nhánh được phép
 *   DEPARTMENT  : departmentId ∈ danh sách
 *   SELF        : chỉ bản thân
 */
export function buildScopeWhere<T extends string>(
  ctx: ScopeContext,
  opts: { employeeIdField?: T; departmentIdField?: string } = {},
): Record<string, unknown> {
  const employeeField = opts.employeeIdField ?? ('employeeId' as T);
  const deptField = opts.departmentIdField ?? 'departmentId';

  switch (ctx.dataScope) {
    case 'ALL_COMPANY':
      return {};
    case 'BRANCH': {
      const branchIds = ctx.scopeRefs.filter((r) => r.startsWith('branch:')).map((r) => r.slice(7));
      if (branchIds.length === 0) return { id: '__none__' }; // không có scope => không thấy gì
      return { [deptField]: { in: branchIds } };
    }
    case 'DEPARTMENT': {
      const deptIds = ctx.scopeRefs.filter((r) => r.startsWith('dept:')).map((r) => r.slice(5));
      if (deptIds.length === 0) return { id: '__none__' };
      return { [deptField]: { in: deptIds } };
    }
    case 'SELF':
    default:
      if (!ctx.employeeId) return { id: '__none__' };
      return { [employeeField]: ctx.employeeId };
  }
}

/**
 * Kiểm tra một hành động có vượt phạm vi dữ liệu không.
 * Trả về true nếu được phép.
 */
export function canAccessEmployee(ctx: ScopeContext, target: { employeeId: string; departmentId?: string | null }): boolean {
  if (ctx.dataScope === 'ALL_COMPANY') return true;
  if (ctx.dataScope === 'SELF') return target.employeeId === ctx.employeeId;
  if (ctx.dataScope === 'DEPARTMENT') {
    const deptIds = ctx.scopeRefs.filter((r) => r.startsWith('dept:')).map((r) => r.slice(5));
    return target.departmentId != null && deptIds.includes(target.departmentId);
  }
  if (ctx.dataScope === 'BRANCH') {
    const branchIds = ctx.scopeRefs.filter((r) => r.startsWith('branch:')).map((r) => r.slice(7));
    return target.departmentId != null && branchIds.includes(target.departmentId);
  }
  return false;
}
