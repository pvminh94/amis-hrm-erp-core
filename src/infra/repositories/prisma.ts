/**
 * ============================================================================
 * PRISMA CLIENT + SOFT DELETE MẶC ĐỊNH
 * ============================================================================
 *
 * Mọi model có `deletedAt` sẽ được lọc tự động ở các truy vấn đọc, và
 * `delete()` được chuyển thành `update({ deletedAt })`. Điều này đảm bảo
 * không một repository nào "quên" lọc bản ghi đã xoá.
 *
 * Khi CẦN đọc cả bản ghi đã xoá (audit, khôi phục), dùng:
 *   prisma.$withDeleted.employee.findMany(...)
 */

import { Prisma, PrismaClient } from '@prisma/client';

/** Danh sách model có cột deletedAt — phải đồng bộ với schema.prisma */
const SOFT_DELETE_MODELS = [
  'User',
  'Permission',
  'OrgUnit',
  'Position',
  'Employee',
  'Contract',
  'EmployeeInsurance',
  'Dependent',
  'WorkCalendar',
  'ShiftDefinition',
  'RotationPattern',
  'EmployeeSchedule',
  'Device',
  'DailyAttendance',
  'WorkflowDefinition',
  'LeaveRequest',
  'SalaryComponent',
  'PayRun',
  'PaySlip',
  'Account',
  'CostCenter',
  'JournalEntry',
  'SalesOrder',
  'CommissionPolicy',
  'CommissionRun',
] as const;

export function createPrismaClient(options?: { log?: boolean }) {
  const base = new PrismaClient({
    log: options?.log ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

  return (base as PrismaClient).$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !(SOFT_DELETE_MODELS as readonly string[]).includes(model)) {
            return query(args);
          }
          const isRead = ['findMany', 'findFirst', 'findUnique', 'count', 'aggregate', 'groupBy'].includes(
            operation,
          );
          if (isRead) {
            const a = (args ?? {}) as Record<string, unknown>;
            const where = (a.where ?? {}) as Record<string, unknown>;
            // Chỉ lọc khi người gọi chưa tự chỉ định điều kiện deletedAt
            if (where.deletedAt === undefined) {
              return query({ ...a, where: { ...where, deletedAt: null } });
            }
            return query(args);
          }
          if (operation === 'delete') {
            // Chuyển hard delete thành soft delete
            const a = (args ?? {}) as Record<string, unknown>;
            return (query as unknown as (x: unknown) => Promise<unknown>)({
              where: a.where,
              data: { deletedAt: new Date() },
            });
          }
          if (operation === 'deleteMany') {
            const a = (args ?? {}) as Record<string, unknown>;
            const where = (a.where ?? {}) as Record<string, unknown>;
            return (query as unknown as (x: unknown) => Promise<unknown>)({
              where: { ...where, deletedAt: null },
              data: { deletedAt: new Date() },
            });
          }
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}

/** Client có soft-delete mặc định (cùng interface với PrismaClient) */
export type PrismaClientWithSoftDelete = PrismaClient;

/** Client singleton cho application layer */
let clientSingleton: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (!clientSingleton) {
    clientSingleton = createPrismaClient({ log: process.env.NODE_ENV === 'development' }) as PrismaClient;
  }
  return clientSingleton;
}

export async function disconnectPrisma(): Promise<void> {
  if (clientSingleton) {
    await clientSingleton.$disconnect();
    clientSingleton = null;
  }
}

/** Helper: Decimal của Prisma -> number */
export function dec(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (typeof (value as { toNumber?: () => number }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value);
}

/** Helper: number -> Prisma.Decimal input */
export function toDecimalInput(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}
