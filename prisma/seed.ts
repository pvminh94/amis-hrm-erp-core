/**
 * ============================================================================
 * SEED DATA — dữ liệu mẫu có kiểm soát (deterministic)
 * ============================================================================
 *
 * Sinh ra:
 *   - 3 chi nhánh, 7 phòng ban (đủ 3 nhóm chi phí 6421/6422/154)
 *   - 12 chức danh, 36 nhân sự (đủ 100–5.000 nhân sự chỉ cần nhân bản)
 *   - Hợp đồng lao động, hồ sơ bảo hiểm, người phụ thuộc
 *   - 7 ca làm việc: hành chính, ca gãy, 3 ca 4 kíp (CA1/CA2/CA3 đêm vắt 0h)
 *   - Lịch phân ca 30 NGÀY cho toàn bộ nhân sự
 *   - Nhật ký quẹt thẻ THÔ + bảng công ngày đã tính (đủ tình huống: đúng giờ,
 *     trễ trong grace, trễ quá grace, thiếu quẹt, OT ngày thường/cuối tuần/lễ,
 *     ca đêm đủ, ca đêm về sớm, vắng không phép, nghỉ phép)
 *   - BẢNG LƯƠNG THẬT: chạy engine tính lương end-to-end và ghi PaySlip
 *   - Đơn từ ở nhiều trạng thái + chuỗi duyệt + nhật ký vết
 *   - Đơn hàng bán hàng để chạy cầu nối hoa hồng
 *
 * DETERMINISTIC: dùng PRNG có seed cố định => chạy bao nhiêu lần cũng ra
 * đúng một bộ dữ liệu, thuận tiện đối soát và viết test hồi quy.
 *
 * Chạy:  npm run seed        (cần DATABASE_URL trỏ tới DB đã migrate)
 */

import {
  Prisma,
  PrismaClient,
  type AttendanceStatus,
  type ComponentCalcMode,
  type CostCenterType,
  type DataScope,
  type RequestStatus,
  type RequestType,
  type UserRole,
  type WorkdayType,
} from '@prisma/client';

import { calculatePayroll, type PayrollEmployeeInput, type PayrollConfig } from '../src/domain/payroll.js';
import { resolveShift, resolveRotationShiftCode, ROTATION_3CA_4KIP } from '../src/domain/shift-resolution.js';
import { pairPunches, type PunchLike } from '../src/domain/punch-pairing.js';
import { buildPolicySnapshot, type WageRegion } from '../src/config/insurance.js';
import { resolveTaxRegime } from '../src/config/tax-regime.js';
import { hashPassword, encrypt } from '../src/infra/crypto/crypto.js';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// PRNG có seed — tái lập được
// ---------------------------------------------------------------------------
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rng = makeRng(20260305);
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
const intBetween = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

// ---------------------------------------------------------------------------
// THAM SỐ KỲ
// ---------------------------------------------------------------------------
const PERIOD_YEAR = Number(process.env.SEED_YEAR ?? 2026);
const PERIOD_MONTH = Number(process.env.SEED_MONTH ?? 3);
const PERIOD_START = `${PERIOD_YEAR}-${String(PERIOD_MONTH).padStart(2, '0')}-01`;
const PERIOD_END = new Date(Date.UTC(PERIOD_YEAR, PERIOD_MONTH, 0)).toISOString().slice(0, 10);
const SEED_DAYS = Number(process.env.SEED_DAYS ?? 30);

const ENCRYPTION_KEY =
  process.env.DATA_ENCRYPTION_KEY ??
  '0000000000000000000000000000000000000000000000000000000000000000';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Amis@123456';

// Trụ sở mẫu (để geofencing hoạt động được)
const HQ = { lat: 10.776889, lng: 106.700806 }; // Quận 1, TP.HCM

// ---------------------------------------------------------------------------
// DANH MỤC
// ---------------------------------------------------------------------------

const HO_TEN = [
  'Trần Minh Tuấn', 'Lê Thị Hương', 'Nguyễn Văn Hùng', 'Phạm Thu Hà', 'Hoàng Anh Đức',
  'Vũ Thị Mai', 'Đặng Quốc Bảo', 'Bùi Thanh Nga', 'Đỗ Văn Long', 'Ngô Thị Lan',
  'Lý Hoàng Nam', 'Trương Mỹ Linh', 'Phan Văn Đạt', 'Hồ Thị Kim Anh', 'Dương Tuấn Kiệt',
  'Đinh Thị Hoa', 'Tạ Quang Vinh', 'Mai Văn Sơn', 'Cao Thị Ngọc', 'Lâm Nhật Hào',
  'Võ Minh Khôi', 'Tống Thị Bích', 'Chu Văn Tài', 'Hà Thu Trang', 'Nghiêm Xuân Phúc',
  'Quách Thị Dung', 'Kiều Mạnh Dũng', 'La Thị Hồng', 'Sầm Văn Kiên', 'Uông Thị Thúy',
  'Văn Công Danh', 'Chế Thị Na', 'Lư Hoàng Vũ', 'Ông Thị Sen', 'Quản Trọng Nghĩa',
  'Cầm Thị Xuyến',
] as const;

const DEPARTMENTS = [
  { code: 'KD', name: 'Phòng Kinh doanh', costCenterType: 'SELLING', gl: '6421', parentId: 'CN_HCM' },
  { code: 'MKT', name: 'Phòng Marketing', costCenterType: 'SELLING', gl: '6421', parentId: 'CN_HCM' },
  { code: 'CSKH', name: 'Phòng Chăm sóc KH', costCenterType: 'SELLING', gl: '6421', parentId: 'CN_HCM' },
  { code: 'HCNS', name: 'Phòng Hành chính Nhân sự', costCenterType: 'ADMIN' as CostCenterType, gl: '6422', parentId: 'HO' },
  { code: 'KETOAN', name: 'Phòng Kế toán', costCenterType: 'ADMIN' as CostCenterType, gl: '6422', parentId: 'HO' },
  { code: 'CNTT', name: 'Phòng Công nghệ TT', costCenterType: 'ADMIN' as CostCenterType, gl: '6422', parentId: 'HO' },
  { code: 'SX', name: 'Xưởng Sản xuất', costCenterType: 'PRODUCTION', gl: '154', parentId: 'CN_BD' },
] as const;

const BRANCHES = [
  { code: 'HO', name: 'Hội sở TP.HCM', type: 'BRANCH' as const },
  { code: 'CN_HCM', name: 'Chi nhánh Quận 1', type: 'BRANCH' as const },
  { code: 'CN_BD', name: 'Chi nhánh Bình Dương', type: 'BRANCH' as const },
] as const;

const POSITIONS = [
  { code: 'GD', name: 'Giám đốc', level: 9 },
  { code: 'TP', name: 'Trưởng phòng', level: 7 },
  { code: 'PP', name: 'Phó phòng', level: 6 },
  { code: 'QL', name: 'Quản lý trực tiếp', level: 5 },
  { code: 'NVKD', name: 'Nhân viên Kinh doanh', level: 3 },
  { code: 'NVKT', name: 'Nhân viên Kế toán', level: 3 },
  { code: 'NVNS', name: 'Nhân viên Nhân sự', level: 3 },
  { code: 'NVIT', name: 'Kỹ sư Phần mềm', level: 4 },
  { code: 'CN', name: 'Công nhân vận hành', level: 2 },
  { code: 'TDP', name: 'Tổ trưởng sản xuất', level: 4 },
  { code: 'BV', name: 'Bảo vệ ca đêm', level: 1 },
  { code: 'TVE', name: 'Thực tập sinh', level: 1 },
] as const;

/** 7 ca làm việc — bao phủ đủ các loại ca trong đề bài */
const SHIFTS = [
  {
    code: 'HC',
    name: 'Ca hành chính 08:00-17:00',
    type: 'OFFICE' as const,
    segments: [{ name: 'Sáng-chiều', start: '08:00', end: '17:00', breakMinutes: 60 }],
    standardHours: 8,
    graceMinutes: 10,
  },
  {
    code: 'GAY',
    name: 'Ca gãy 08-12 & 14-18',
    type: 'SPLIT' as const,
    segments: [
      { name: 'Sáng', start: '08:00', end: '12:00' },
      { name: 'Chiều', start: '14:00', end: '18:00' },
    ],
    standardHours: 8,
    graceMinutes: 10,
  },
  {
    code: 'CA1',
    name: 'Ca 1 — Sáng 06:00-14:00',
    type: 'ROTATING' as const,
    segments: [{ name: 'Sáng', start: '06:00', end: '14:00', breakMinutes: 30 }],
    standardHours: 7.5,
    graceMinutes: 5,
  },
  {
    code: 'CA2',
    name: 'Ca 2 — Chiều 14:00-22:00',
    type: 'ROTATING' as const,
    segments: [{ name: 'Chiều', start: '14:00', end: '22:00', breakMinutes: 30 }],
    standardHours: 7.5,
    graceMinutes: 5,
  },
  {
    code: 'CA3',
    name: 'Ca 3 — Đêm 22:00-06:00 (vắt qua 0h)',
    type: 'NIGHT_CROSS_DAY' as const,
    segments: [{ name: 'Đêm', start: '22:00', end: '06:00', breakMinutes: 30 }],
    standardHours: 7.5,
    graceMinutes: 5,
  },
  {
    code: 'BV_DEM',
    name: 'Bảo vệ đêm 20:00-06:00',
    type: 'NIGHT_CROSS_DAY' as const,
    segments: [{ name: 'Đêm', start: '20:00', end: '06:00', breakMinutes: 60 }],
    standardHours: 9,
    graceMinutes: 10,
  },
  {
    code: 'LINH_HOAT',
    name: 'Ca linh hoạt 08:00-18:00',
    type: 'FLEXIBLE' as const,
    segments: [{ name: 'Linh hoạt', start: '08:00', end: '18:00', breakMinutes: 60 }],
    standardHours: 8,
    graceMinutes: 30,
  },
] as const;

/** Nhóm nhân sự → ca làm việc */
const SHIFT_BY_DEPT: Record<string, string[]> = {
  KD: ['HC'],
  MKT: ['HC'],
  CSKH: ['HC', 'GAY'],
  HCNS: ['HC'],
  KETOAN: ['HC'],
  CNTT: ['LINH_HOAT'],
  SX: ['CA1', 'CA2', 'CA3'], // hệ 3 ca 4 kíp
};

const ROTATION_TEAM_BY_INDEX: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3 };

const BANK_CODES = ['VCB', 'TCB', 'CTG', 'MBB'] as const;

// ---------------------------------------------------------------------------
// HÀM TIỆN ÍCH
// ---------------------------------------------------------------------------

function dateAddDays(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toUtc(dateStr: string, minutes: number, dayOffset = 0): Date {
  const base = new Date(`${dateAddDays(dateStr, dayOffset)}T00:00:00.000Z`).getTime();
  return new Date(base + minutes * 60_000 - 7 * 3_600_000);
}

function maskNationalId(id: string): string {
  return id.slice(-4);
}

// ---------------------------------------------------------------------------
// SEED
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n=== SEED AMIS HRM & ERP CORE ===`);
  console.log(`Kỳ lương: ${PERIOD_MONTH}/${PERIOD_YEAR} (${PERIOD_START} → ${PERIOD_END}), ${SEED_DAYS} ngày lịch`);

  const keyBuf = Buffer.from(ENCRYPTION_KEY, 'hex');
  const passwordHash = await hashPassword(PASSWORD, 10);

  // --- 0. Dọn dữ liệu cũ (soft-delete tables + hard delete tables vận hành) ---
  await prisma.journalLine.deleteMany();
  await prisma.journalEntry.deleteMany();
  await prisma.paymentFile.deleteMany();
  await prisma.paySlip.deleteMany();
  await prisma.payRun.deleteMany();
  await prisma.approvalAuditTrail.deleteMany();
  await prisma.approvalStep.deleteMany();
  await prisma.leaveRequest.deleteMany();
  await prisma.rawPunch.deleteMany();
  await prisma.dailyAttendance.deleteMany();
  await prisma.employeeSchedule.deleteMany();
  await prisma.commissionRun.deleteMany();
  await prisma.salesOrder.deleteMany();
  await prisma.biometricEnrollment.deleteMany();
  await prisma.dependent.deleteMany();
  await prisma.employeeInsurance.deleteMany();
  await prisma.contract.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.employee.deleteMany({ where: {} });
  await prisma.device.deleteMany();
  await prisma.position.deleteMany();
  await prisma.shiftDefinition.deleteMany();
  await prisma.calendarDay.deleteMany();
  await prisma.workCalendar.deleteMany();
  await prisma.costCenter.deleteMany();
  await prisma.orgUnit.deleteMany();
  await prisma.user.deleteMany();
  await prisma.account.deleteMany();
  await prisma.salaryComponent.deleteMany();

  // --- 1. Hệ thống tài khoản kế toán -----------------------------------------
  const accounts = [
    { code: '1111', name: 'Tiền mặt VND', type: 'ASSET', normalSide: 'DEBIT' },
    { code: '1121', name: 'Tiền gửi ngân hàng VND', type: 'ASSET', normalSide: 'DEBIT' },
    { code: '1388', name: 'Phải thu khác', type: 'ASSET', normalSide: 'DEBIT' },
    { code: '141', name: 'Tạm ứng', type: 'ASSET', normalSide: 'DEBIT' },
    { code: '154', name: 'Chi phí SXKD dở dang', type: 'ASSET', normalSide: 'DEBIT' },
    { code: '334', name: 'Phải trả người lao động', type: 'LIABILITY', normalSide: 'CREDIT' },
    { code: '3382', name: 'Kinh phí công đoàn', type: 'LIABILITY', normalSide: 'CREDIT' },
    { code: '3383', name: 'BHXH phải nộp', type: 'LIABILITY', normalSide: 'CREDIT' },
    { code: '3384', name: 'BHYT phải nộp', type: 'LIABILITY', normalSide: 'CREDIT' },
    { code: '3386', name: 'BHTN phải nộp', type: 'LIABILITY', normalSide: 'CREDIT' },
    { code: '3388', name: 'BHTNLĐ-BNN phải nộp', type: 'LIABILITY', normalSide: 'CREDIT' },
    { code: '3335', name: 'Thuế TNCN phải nộp', type: 'LIABILITY', normalSide: 'CREDIT' },
    { code: '6421', name: 'Chi phí bán hàng', type: 'EXPENSE', normalSide: 'DEBIT' },
    { code: '6422', name: 'Chi phí quản lý doanh nghiệp', type: 'EXPENSE', normalSide: 'DEBIT' },
  ];
  for (const a of accounts) await prisma.account.create({ data: a });
  console.log(`✓ ${accounts.length} tài khoản kế toán`);

  // --- 2. Cây tổ chức ----------------------------------------------------------
  const root = await prisma.orgUnit.create({
    data: {
      code: 'AMIS',
      name: 'Công ty CP Công nghệ AMIS',
      type: 'COMPANY',
      costCenterType: 'ADMIN' as CostCenterType,
      glExpenseAccount: '6422',
      latitude: new Prisma.Decimal(HQ.lat),
      longitude: new Prisma.Decimal(HQ.lng),
      geofenceRadiusM: 200,
      wifiBssids: ['aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:02'],
    },
  });

  const branchMap: Record<string, string> = {};
  for (const b of BRANCHES) {
    const created = await prisma.orgUnit.create({
      data: {
        code: b.code,
        name: b.name,
        type: b.type,
        parentId: root.id,
        costCenterType: 'ADMIN' as CostCenterType,
        glExpenseAccount: '6422',
        latitude: new Prisma.Decimal(HQ.lat + (b.code === 'CN_BD' ? 0.35 : 0)),
        longitude: new Prisma.Decimal(HQ.lng + (b.code === 'CN_BD' ? 0.4 : 0)),
        geofenceRadiusM: 250,
        wifiBssids: [`aa:bb:cc:dd:${b.code.toLowerCase().replace('_', '')}:01`],
      },
    });
    branchMap[b.code] = created.id;
  }

  const deptMap: Record<string, { id: string; gl: string; costCenterType: string }> = {};
  for (const d of DEPARTMENTS) {
    const created = await prisma.orgUnit.create({
      data: {
        code: d.code,
        name: d.name,
        type: 'DEPARTMENT',
        parentId: branchMap[d.parentId]!,
        costCenterType: d.costCenterType,
        glExpenseAccount: d.gl,
      },
    });
    deptMap[d.code] = { id: created.id, gl: d.gl, costCenterType: d.costCenterType };
    await prisma.costCenter.create({
      data: {
        code: `CC-${d.code}`,
        name: d.name,
        type: d.costCenterType,
        orgUnitId: created.id,
        glAccount: d.gl,
      },
    });
  }
  console.log(`✓ ${BRANCHES.length} chi nhánh, ${DEPARTMENTS.length} phòng ban, ${DEPARTMENTS.length} cost center`);

  // --- 3. Chức danh ------------------------------------------------------------
  const posMap: Record<string, string> = {};
  for (const p of POSITIONS) {
    const created = await prisma.position.create({ data: { code: p.code, name: p.name, level: p.level } });
    posMap[p.code] = created.id;
  }
  console.log(`✓ ${POSITIONS.length} chức danh`);

  // --- 4. Lịch làm việc + ngày lễ -----------------------------------------------
  const calendar = await prisma.workCalendar.create({
    data: { code: 'CAL_VN', name: 'Lịch Việt Nam (nghỉ CN)', workingDays: [1, 2, 3, 4, 5, 6] },
  });
  // Ngày lễ trong kỳ mẫu
  const holidays = [`${PERIOD_YEAR}-${String(PERIOD_MONTH).padStart(2, '0')}-10`];
  for (let i = 0; i < SEED_DAYS; i += 1) {
    const dateStr = dateAddDays(PERIOD_START, i);
    const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
    let type: WorkdayType = 'WORKING_DAY';
    if (holidays.includes(dateStr)) type = 'PUBLIC_HOLIDAY';
    else if (dow === 0) type = 'WEEKLY_REST_DAY';
    await prisma.calendarDay.create({
      data: {
        calendarId: calendar.id,
        date: new Date(`${dateStr}T00:00:00.000Z`),
        type,
        label: type === 'PUBLIC_HOLIDAY' ? 'Ngày lễ' : null,
        isPaid: type === 'WORKING_DAY',
      },
    });
  }
  console.log(`✓ ${SEED_DAYS} ngày lịch (${holidays.length} ngày lễ)`);

  // --- 5. Ca làm việc --------------------------------------------------------------
  const shiftMap: Record<string, string> = {};
  for (const s of SHIFTS) {
    const created = await prisma.shiftDefinition.create({
      data: {
        code: s.code,
        name: s.name,
        type: s.type,
        standardHours: new Prisma.Decimal(s.standardHours),
        segmentCount: s.segments.length,
        segments: s.segments as unknown as Prisma.InputJsonValue,
        crossMidnight: s.type === 'NIGHT_CROSS_DAY',
        graceMinutes: s.graceMinutes,
        calendarId: calendar.id,
      },
    });
    shiftMap[s.code] = created.id;
  }
  console.log(`✓ ${SHIFTS.length} ca làm việc (có ca đêm vắt 0h và ca gãy)`);

  // --- 6. Thiết bị chấm công ---------------------------------------------------------
  const devices = [
    { code: 'DEV_HIK_HO', name: 'FaceID Hội sở', protocol: 'hikvision', sn: 'DS-K1T671M-001', orgUnitId: root.id, lat: HQ.lat, lng: HQ.lng },
    { code: 'DEV_RJ_SX', name: 'Ronald Jack Xưởng SX', protocol: 'ronald_jack', sn: 'RJ-W600-002', orgUnitId: branchMap.CN_BD!, lat: HQ.lat + 0.35, lng: HQ.lng + 0.4 },
    { code: 'DEV_ZK_Q1', name: 'ZKTeco Chi nhánh Q1', protocol: 'zkteco', sn: 'ZK-MB360-003', orgUnitId: branchMap.CN_HCM!, lat: HQ.lat, lng: HQ.lng },
  ];
  for (const d of devices) {
    await prisma.device.create({
      data: {
        code: d.code,
        name: d.name,
        protocol: d.protocol,
        serialNumber: d.sn,
        pushToken: 'device-push-token-demo',
        orgUnitId: d.orgUnitId,
        latitude: new Prisma.Decimal(d.lat),
        longitude: new Prisma.Decimal(d.lng),
      },
    });
  }
  console.log(`✓ ${devices.length} thiết bị chấm công`);

  // --- 7. Người dùng quản trị ---------------------------------------------------------
  const adminRoles: Array<{ username: string; role: UserRole; scope: DataScope; email: string }> = [
    { username: 'admin', role: 'SUPER_ADMIN', scope: 'ALL_COMPANY', email: 'admin@amis.local' },
    { username: 'hr.admin', role: 'HR_ADMIN', scope: 'ALL_COMPANY', email: 'hr.admin@amis.local' },
    { username: 'hr.staff', role: 'HR_STAFF', scope: 'DEPARTMENT', email: 'hr.staff@amis.local' },
    { username: 'ketoan.truong', role: 'CHIEF_ACCOUNTANT', scope: 'ALL_COMPANY', email: 'ktt@amis.local' },
    { username: 'tonggiamdoc', role: 'CEO', scope: 'ALL_COMPANY', email: 'ceo@amis.local' },
  ];
  const userIds: Record<string, string> = {};
  for (const u of adminRoles) {
    const created = await prisma.user.create({
      data: {
        username: u.username,
        email: u.email,
        passwordHash,
        role: u.role,
        dataScope: u.scope,
        scopeRefs: u.scope === 'DEPARTMENT' ? [`dept:${deptMap.HCNS!.id}`] : [],
      },
    });
    userIds[u.username] = created.id;
  }
  console.log(`✓ ${adminRoles.length} tài khoản quản trị (mật khẩu: ${PASSWORD})`);

  // --- 8. Nhân sự ----------------------------------------------------------------------
  interface EmpSeed {
    id: string;
    code: string;
    fullName: string;
    dept: string;
    position: string;
    baseSalary: number;
    contractSalary: number;
    kpi: number;
    managerId: string | null;
    userId: string | null;
    teamIndex: number;
    isProbation: boolean;
    dependents: number;
    region: WageRegion;
    email: string;
  }
  const employees: EmpSeed[] = [];
  const deptHeads: Record<string, string> = {};

  // Trưởng phòng trước (để làm manager cho nhân viên)
  const headPlan: Array<[string, string, number, number]> = [
    ['KD', 'GD', 45_000_000, 50_000_000],
    ['MKT', 'TP', 32_000_000, 36_000_000],
    ['CSKH', 'TP', 28_000_000, 32_000_000],
    ['HCNS', 'TP', 30_000_000, 34_000_000],
    ['KETOAN', 'TP', 33_000_000, 38_000_000],
    ['CNTT', 'TP', 55_000_000, 62_000_000],
    ['SX', 'TDP', 18_000_000, 20_000_000],
  ];

  let seq = 0;
  for (const [dept, pos, base, contract] of headPlan) {
    seq += 1;
    const code = `NV${String(seq).padStart(4, '0')}`;
    const fullName = HO_TEN[(seq - 1) % HO_TEN.length]!;
    const username = code.toLowerCase();
    const user = await prisma.user.create({
      data: {
        username,
        email: `${username}@amis.local`,
        passwordHash,
        role: 'DEPARTMENT_HEAD',
        dataScope: 'DEPARTMENT',
        scopeRefs: [`dept:${deptMap[dept]!.id}`],
      },
    });
    const emp = await prisma.employee.create({
      data: {
        code,
        fullName,
        gender: seq % 2 === 0 ? 'FEMALE' : 'MALE',
        dateOfBirth: new Date(`19${intBetween(75, 95)}-0${intBetween(1, 9)}-1${intBetween(0, 9)}`),
        nationalIdEnc: encrypt(`0790${String(100000000 + seq).slice(-8)}`, keyBuf).cipher,
        nationalIdHint: maskNationalId(`0790${String(100000000 + seq).slice(-8)}`),
        taxCode: `8${String(1000000 + seq).slice(-7)}`,
        bankAccountEnc: encrypt(String(710000000000 + seq * 137), keyBuf).cipher,
        bankCode: pick(BANK_CODES),
        bankBranch: 'Chi nhánh TP.HCM',
        phone: `09${String(10000000 + seq).slice(-8)}`,
        email: `${username}@amis.local`,
        departmentId: deptMap[dept]!.id,
        positionId: posMap[pos]!,
        hireDate: new Date(`20${intBetween(15, 23)}-0${intBetween(1, 9)}-15`),
        status: 'ACTIVE',
        wageRegion: dept === 'SX' ? 'II' : 'I',
        userId: user.id,
      },
    });
    deptHeads[dept] = emp.id;
    employees.push({
      id: emp.id,
      code,
      fullName,
      dept,
      position: pos,
      baseSalary: base,
      contractSalary: contract,
      kpi: intBetween(80, 100),
      managerId: null,
      userId: user.id,
      teamIndex: 0,
      isProbation: false,
      dependents: intBetween(0, 3),
      region: dept === 'SX' ? 'II' : 'I',
      email: `${username}@amis.local`,
    });
  }

  // Nhân viên thường
  const staffPlan: Array<[string, string, number, number]> = [];
  for (const [dept, pos, base] of [
    ['KD', 'NVKD', 12_000_000],
    ['KD', 'NVKD', 14_000_000],
    ['KD', 'QL', 20_000_000],
    ['MKT', 'NVKD', 13_000_000],
    ['MKT', 'NVKD', 11_000_000],
    ['CSKH', 'NVKD', 10_000_000],
    ['CSKH', 'NVKD', 9_500_000],
    ['CSKH', 'TVE', 5_000_000],
    ['HCNS', 'NVNS', 14_000_000],
    ['HCNS', 'NVNS', 12_500_000],
    ['KETOAN', 'NVKT', 16_000_000],
    ['KETOAN', 'NVKT', 15_000_000],
    ['KETOAN', 'NVKT', 18_000_000],
    ['CNTT', 'NVIT', 38_000_000],
    ['CNTT', 'NVIT', 42_000_000],
    ['CNTT', 'NVIT', 60_000_000], // lương cao để kiểm tra TRẦN BHXH
    ['CNTT', 'QL', 48_000_000],
    ['SX', 'CN', 8_500_000],
    ['SX', 'CN', 9_000_000],
    ['SX', 'CN', 8_000_000],
    ['SX', 'CN', 9_500_000],
    ['SX', 'CN', 8_800_000],
    ['SX', 'CN', 9_200_000],
    ['SX', 'CN', 8_300_000],
    ['SX', 'CN', 10_000_000],
    ['SX', 'CN', 7_500_000],
    ['SX', 'BV', 7_000_000],
    ['SX', 'BV', 7_200_000],
    ['KD', 'NVKD', 200_000_000], // lương rất cao — kiểm tra trần BHTN vùng I
  ] as const) {
    staffPlan.push([dept as string, pos as string, base as number, Math.round((base as number) * 1.15)]);
  }

  for (const [dept, pos, base, contract] of staffPlan) {
    seq += 1;
    const code = `NV${String(seq).padStart(4, '0')}`;
    const fullName = HO_TEN[(seq - 1) % HO_TEN.length]!;
    const username = code.toLowerCase();
    const isProbation = pos === 'TVE';
    const user = await prisma.user.create({
      data: {
        username,
        email: `${username}@amis.local`,
        passwordHash,
        role: pos === 'QL' ? 'DIRECT_LINE_MANAGER' : 'EMPLOYEE',
        dataScope: 'SELF',
      },
    });
    const emp = await prisma.employee.create({
      data: {
        code,
        fullName,
        gender: seq % 2 === 0 ? 'FEMALE' : 'MALE',
        dateOfBirth: new Date(`19${intBetween(80, 2002 % 100).toString().padStart(2, '0')}-0${intBetween(1, 9)}-1${intBetween(0, 9)}`),
        nationalIdEnc: encrypt(`0791${String(100000000 + seq).slice(-8)}`, keyBuf).cipher,
        nationalIdHint: maskNationalId(`0791${String(100000000 + seq).slice(-8)}`),
        taxCode: `8${String(1000000 + seq).slice(-7)}`,
        bankAccountEnc: encrypt(String(710000000000 + seq * 137), keyBuf).cipher,
        bankCode: pick(BANK_CODES),
        bankBranch: 'Chi nhánh TP.HCM',
        phone: `09${String(10000000 + seq).slice(-8)}`,
        email: `${username}@amis.local`,
        departmentId: deptMap[dept]!.id,
        positionId: posMap[pos]!,
        managerId: pos === 'QL' ? deptHeads[dept]! : (deptHeads[dept] ?? null),
        hireDate: new Date(`20${intBetween(18, 25)}-0${intBetween(1, 9)}-10`),
        status: isProbation ? 'PROBATION' : 'ACTIVE',
        wageRegion: dept === 'SX' ? 'II' : 'I',
        userId: user.id,
      },
    });

    const teamIndex = dept === 'SX' ? (seq % 4) : 0;
    employees.push({
      id: emp.id,
      code,
      fullName,
      dept,
      position: pos,
      baseSalary: base,
      contractSalary: contract,
      kpi: intBetween(70, 100),
      managerId: deptHeads[dept] ?? null,
      userId: user.id,
      teamIndex,
      isProbation,
      dependents: intBetween(0, 3),
      region: dept === 'SX' ? 'II' : 'I',
      email: `${username}@amis.local`,
    });
  }
  console.log(`✓ ${employees.length} nhân sự (đủ dải lương 5tr – 200tr để kiểm tra trần BH)`);

  // Cập nhật managerId cho phòng ban
  for (const [dept, empId] of Object.entries(deptHeads)) {
    await prisma.orgUnit.update({ where: { id: deptMap[dept]!.id }, data: { managerId: empId } });
  }

  // --- 9. Hợp đồng + bảo hiểm + người phụ thuộc ----------------------------------------
  for (const e of employees) {
    await prisma.contract.create({
      data: {
        contractNo: `HD${e.code}`,
        employeeId: e.id,
        type: e.isProbation ? 'PROBATION' : 'INDEFINITE',
        startDate: new Date('2023-01-01'),
        baseSalary: e.baseSalary,
        contractSalary: e.contractSalary,
        maxKpiSalary: Math.round(e.baseSalary * 0.2),
        probationRate: new Prisma.Decimal('0.85'),
        signedAt: new Date('2023-01-01'),
      },
    });
    await prisma.employeeInsurance.create({
      data: {
        employeeId: e.id,
        siNumber: `SI${e.code}`,
        hiNumber: `HI${e.code}`,
        enrolledFrom: new Date('2023-01-01'),
      },
    });
    for (let d = 0; d < e.dependents; d += 1) {
      await prisma.dependent.create({
        data: {
          employeeId: e.id,
          fullName: `Người phụ thuộc ${d + 1} của ${e.fullName}`,
          relationship: d === 0 ? 'CON' : 'CHA_ME',
          dateOfBirth: new Date(`20${intBetween(10, 20)}-0${intBetween(1, 9)}-05`),
          validFrom: new Date('2024-01-01'),
          isVerified: true,
        },
      });
    }
  }
  console.log(`✓ ${employees.length} hợp đồng + hồ sơ BHXH + ${employees.reduce((a, b) => a + b.dependents, 0)} người phụ thuộc`);

  // --- 10. Lịch phân ca + quẹt thẻ + bảng công 30 NGÀY ---------------------------------
  const payrollInputs: PayrollEmployeeInput[] = [];
  let punchCount = 0;
  let attendanceCount = 0;
  let scheduleCount = 0;

  const holidaySet = new Set(holidays);

  for (const e of employees) {
    const shiftCodes = SHIFT_BY_DEPT[e.dept] ?? ['HC'];
    const isRotating = shiftCodes.length > 1;
    const stats = {
      workedDays: 0,
      scheduledDays: 0,
      paidLeaveDays: 0,
      unpaidLeaveDays: 0,
      nightHours: 0,
      otWeekdayHours: 0,
      otWeekendHours: 0,
      otHolidayHours: 0,
      lateCount: 0,
      lateMinutes: 0,
      earlyLeaveCount: 0,
      missingPunchCount: 0,
      absentDays: 0,
    };

    for (let i = 0; i < SEED_DAYS; i += 1) {
      const dateStr = dateAddDays(PERIOD_START, i);
      const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
      const isHoliday = holidaySet.has(dateStr);
      const isSunday = dow === 0;

      // Xác định ca
      let shiftCode: string | null;
      if (isRotating) {
        shiftCode = resolveRotationShiftCode(dateStr, PERIOD_START, ROTATION_TEAM_BY_INDEX[e.teamIndex] ?? 0, ROTATION_3CA_4KIP);
      } else {
        shiftCode = shiftCodes[0] ?? null;
      }
      if (e.position === 'BV') shiftCode = 'BV_DEM';
      if (!shiftCode) continue; // ngày nghỉ theo kíp

      const shiftDef = SHIFTS.find((s) => s.code === shiftCode)!;
      const resolved = resolveShift(shiftDef as never, dateStr);

      const dayKind = isHoliday ? 'PUBLIC_HOLIDAY' : isSunday ? 'WEEKLY_REST' : 'WORKING_DAY';

      // Ghi lịch phân ca
      await prisma.employeeSchedule.create({
        data: {
          employeeId: e.id,
          workDate: new Date(`${dateStr}T00:00:00.000Z`),
          shiftId: shiftMap[shiftCode]!,
          calendarDayId: null,
        },
      });
      scheduleCount += 1;

      // Ngày nghỉ theo lịch: 85% không đi làm
      if (dayKind !== 'WORKING_DAY' && rng() < 0.85) continue;

      stats.scheduledDays += 1;

      // Kịch bản quẹt thẻ (deterministic theo rng)
      const roll = rng();
      let scenario: 'ontime' | 'grace' | 'late' | 'missing_out' | 'missing_in' | 'ot' | 'absent' | 'early';
      if (dayKind !== 'WORKING_DAY') scenario = 'ot';
      else if (roll < 0.62) scenario = 'ontime';
      else if (roll < 0.72) scenario = 'grace';
      else if (roll < 0.8) scenario = 'late';
      else if (roll < 0.84) scenario = 'missing_out';
      else if (roll < 0.87) scenario = 'missing_in';
      else if (roll < 0.92) scenario = 'ot';
      else if (roll < 0.95) scenario = 'early';
      else scenario = 'absent';

      const punches: PunchLike[] = [];
      const first = resolved.segments[0]!;
      const last = resolved.segments[resolved.segments.length - 1]!;
      let extraOtMinutes = 0;

      const makePunch = (abs: number, dir: 'IN' | 'OUT'): { absMinute: number; direction: 'IN' | 'OUT' } => ({
        absMinute: Math.round(abs),
        direction: dir,
      });

      switch (scenario) {
        case 'absent':
          break;
        case 'ontime':
          punches.push(makePunch(first.absStart - intBetween(2, 12), 'IN'));
          punches.push(makePunch(last.absEnd + intBetween(0, 8), 'OUT'));
          break;
        case 'grace':
          punches.push(makePunch(first.absStart + intBetween(1, shiftDef.graceMinutes), 'IN'));
          punches.push(makePunch(last.absEnd + intBetween(0, 5), 'OUT'));
          break;
        case 'late': {
          const late = intBetween(shiftDef.graceMinutes + 5, 60);
          punches.push(makePunch(first.absStart + late, 'IN'));
          punches.push(makePunch(last.absEnd + intBetween(0, 5), 'OUT'));
          break;
        }
        case 'early': {
          const early = intBetween(15, 60);
          punches.push(makePunch(first.absStart - intBetween(1, 8), 'IN'));
          punches.push(makePunch(last.absEnd - early, 'OUT'));
          break;
        }
        case 'missing_out':
          punches.push(makePunch(first.absStart - intBetween(1, 10), 'IN'));
          break;
        case 'missing_in':
          punches.push(makePunch(last.absEnd + intBetween(0, 6), 'OUT'));
          break;
        case 'ot': {
          extraOtMinutes = intBetween(60, 180);
          punches.push(makePunch(first.absStart - intBetween(1, 10), 'IN'));
          punches.push(makePunch(last.absEnd + extraOtMinutes, 'OUT'));
          break;
        }
        default:
          break;
      }

      // Ghi RawPunch thật
      const deviceIdx = e.dept === 'SX' ? 1 : 0;
      for (const p of punches) {
        const absDate = resolved.workDate;
        const dayOffset = Math.floor(p.absMinute / 1440);
        const minuteOfDay = p.absMinute - dayOffset * 1440;
        const punchAt = toUtc(absDate, minuteOfDay, dayOffset);
        const dedupe = `${devices[deviceIdx]!.sn}|${e.code}|${Math.floor(punchAt.getTime() / 1000)}`;
        await prisma.rawPunch.create({
          data: {
            employeeId: e.id,
            deviceUserId: e.code,
            deviceId: null,
            punchAt,
            direction: p.direction as 'IN' | 'OUT',
            source: 'ADMS_PUSH',
            dedupeHash: Buffer.from(dedupe).toString('base64url').slice(0, 64),
            geofenceOk: true,
            distanceM: intBetween(5, 90),
            isFaceVerified: true,
          },
        });
        punchCount += 1;
      }

      // Tính công bằng engine thật
      const result = pairPunches(resolved, punches, dayKind as never, {
        graceMinutes: shiftDef.graceMinutes,
      });

      const statusMap: Record<string, AttendanceStatus> = {
        PRESENT: 'PRESENT',
        LATE: 'LATE',
        ABSENT: 'ABSENT',
        HALF_DAY: 'HALF_DAY',
        MISSING_PUNCH: 'MISSING_PUNCH',
        WEEKLY_OFF: 'WEEKLY_OFF',
        HOLIDAY_OFF: 'HOLIDAY_OFF',
      };

      await prisma.dailyAttendance.create({
        data: {
          employeeId: e.id,
          workDate: new Date(`${dateStr}T00:00:00.000Z`),
          shiftId: shiftMap[shiftCode]!,
          status: statusMap[result.status] ?? 'PRESENT',
          checkInAt: result.checkInAbs !== null ? toUtc(dateStr, result.checkInAbs % 1440, Math.floor(result.checkInAbs / 1440)) : null,
          checkOutAt: result.checkOutAbs !== null ? toUtc(dateStr, result.checkOutAbs % 1440, Math.floor(result.checkOutAbs / 1440)) : null,
          segments: { detail: result.segments, warnings: result.warnings } as unknown as Prisma.InputJsonValue,
          plannedHours: new Prisma.Decimal((resolved.totalNetMinutes / 60).toFixed(2)),
          workedHours: new Prisma.Decimal((result.workedMinutes / 60).toFixed(2)),
          standardDays: new Prisma.Decimal(result.standardDays.toFixed(3)),
          lateMinutes: result.lateMinutes,
          earlyLeaveMin: result.earlyLeaveMinutes,
          absentMinutes: result.absentMinutes,
          nightHours: new Prisma.Decimal(result.nightHours.toFixed(2)),
          otWeekdayHours: new Prisma.Decimal((result.otWeekdayMinutes / 60).toFixed(2)),
          otWeekendHours: new Prisma.Decimal((result.otWeekendMinutes / 60).toFixed(2)),
          otHolidayHours: new Prisma.Decimal((result.otHolidayMinutes / 60).toFixed(2)),
          otNightHours: new Prisma.Decimal((result.otNightMinutes / 60).toFixed(2)),
          regularizedHours: new Prisma.Decimal((result.regularizedMinutes / 60).toFixed(2)),
          lastComputedAt: new Date(),
        },
      });
      attendanceCount += 1;

      // Cộng dồn cho bảng lương
      stats.workedDays += result.standardDays;
      stats.paidLeaveDays += result.status === 'LEAVE_PAID' ? 1 : 0;
      stats.nightHours += result.nightHours;
      stats.otWeekdayHours += result.otWeekdayMinutes / 60;
      stats.otWeekendHours += result.otWeekendMinutes / 60;
      stats.otHolidayHours += result.otHolidayMinutes / 60;
      if (result.lateMinutes > 0) {
        stats.lateCount += 1;
        stats.lateMinutes += result.lateMinutes;
      }
      if (result.earlyLeaveMinutes > 0) stats.earlyLeaveCount += 1;
      if (result.status === 'MISSING_PUNCH') stats.missingPunchCount += 1;
      if (result.status === 'ABSENT') stats.absentDays += 1;
    }

    payrollInputs.push({
      employeeId: e.id,
      employeeCode: e.code,
      fullName: e.fullName,
      costAccount: deptMap[e.dept]!.gl,
      costCenterCode: `CC-${e.dept}`,
      contract: {
        baseSalary: e.baseSalary,
        contractSalary: e.contractSalary,
        maxKpiSalary: Math.round(e.baseSalary * 0.2),
        isProbation: e.isProbation,
        probationRate: 0.85,
      },
      insurance: { wageRegion: e.region },
      attendance: {
        workedDays: Number(stats.workedDays.toFixed(3)),
        scheduledDays: stats.scheduledDays,
        paidLeaveDays: stats.paidLeaveDays,
        unpaidLeaveDays: stats.unpaidLeaveDays,
        nightHours: Number(stats.nightHours.toFixed(2)),
        otWeekdayHours: Number(stats.otWeekdayHours.toFixed(2)),
        otWeekendHours: Number(stats.otWeekendHours.toFixed(2)),
        otHolidayHours: Number(stats.otHolidayHours.toFixed(2)),
        lateCount: stats.lateCount,
        lateMinutes: stats.lateMinutes,
        earlyLeaveCount: stats.earlyLeaveCount,
        missingPunchCount: stats.missingPunchCount,
        absentDays: stats.absentDays,
      },
      kpiScore: e.kpi,
      dependents: e.dependents,
      advance: rng() < 0.15 ? 2_000_000 : 0,
    });
  }
  console.log(`✓ ${scheduleCount} lịch phân ca, ${punchCount} quẹt thẻ thô, ${attendanceCount} bản ghi công ngày`);

  // --- 11. ĐƠN HÀNG BÁN HÀNG (cầu nối hoa hồng) -----------------------------------------
  const salesStaff = employees.filter((e) => e.position === 'NVKD');
  let orderCount = 0;
  let orderTotal = 0;
  const commissionByEmployee = new Map<string, number>();
  for (const s of salesStaff) {
    const n = intBetween(3, 8);
    for (let i = 0; i < n; i += 1) {
      orderCount += 1;
      const amount = intBetween(50, 800) * 1_000_000;
      const commission = Math.round(amount * 0.03);
      orderTotal += amount;
      commissionByEmployee.set(s.id, (commissionByEmployee.get(s.id) ?? 0) + commission);
      await prisma.salesOrder.create({
        data: {
          orderNo: `SO${PERIOD_YEAR}${String(orderCount).padStart(5, '0')}`,
          employeeId: s.id,
          customerName: `Khách hàng ${orderCount}`,
          status: 'PAID',
          orderDate: new Date(`${dateAddDays(PERIOD_START, intBetween(0, SEED_DAYS - 1))}T00:00:00.000Z`),
          revenueDate: new Date(`${dateAddDays(PERIOD_START, intBetween(0, SEED_DAYS - 1))}T00:00:00.000Z`),
          totalAmount: amount,
          discountAmount: Math.round(amount * 0.02),
          netRevenue: Math.round(amount * 0.98),
          isCountedForCommission: true,
        },
      });
    }
  }
  console.log(`✓ ${orderCount} đơn hàng bán hàng (tổng ${(orderTotal / 1e9).toFixed(1)} tỷ) cho ${salesStaff.length} NVKD`);

  // Gán hoa hồng vào input lương
  for (const input of payrollInputs) {
    const commission = commissionByEmployee.get(input.employeeId);
    if (commission) {
      input.commission = commission;
      input.commissionRevenue = Math.round(commission / 0.03);
    }
  }

  // --- 12. BẢNG LƯƠNG — chạy engine end-to-end ------------------------------------------
  const regime = resolveTaxRegime(PERIOD_END, process.env.PAYROLL_TAX_REGIME ?? 'AUTO');
  const policy = buildPolicySnapshot(PERIOD_END);
  const payrollConfig: Partial<PayrollConfig> = {
    periodEnd: PERIOD_END,
    taxRegime: process.env.PAYROLL_TAX_REGIME ?? 'AUTO',
    standardWorkHours: 8,
    standardWorkDays: 26,
    mealPerDay: 30_000,
    mealTaxExemptCap: 730_000,
  };

  const payRun = await prisma.payRun.create({
    data: {
      code: `PR${PERIOD_YEAR}${String(PERIOD_MONTH).padStart(2, '0')}`,
      name: `Bảng lương tháng ${PERIOD_MONTH}/${PERIOD_YEAR}`,
      periodYear: PERIOD_YEAR,
      periodMonth: PERIOD_MONTH,
      periodFrom: new Date(`${PERIOD_START}T00:00:00.000Z`),
      periodTo: new Date(`${PERIOD_END}T00:00:00.000Z`),
      status: 'DRAFT',
      taxRegimeCode: regime.code,
      policySnapshot: policy as unknown as Prisma.InputJsonValue,
    },
  });

  let totals = { gross: 0, net: 0, siE: 0, siEm: 0, pit: 0 };
  const calcErrors: Array<{ code: string; error: string }> = [];
  for (const input of payrollInputs) {
    try {
      const r = calculatePayroll(input, payrollConfig);
      totals.gross += r.gross;
      totals.net += r.net;
      totals.siE += r.totalInsuranceEmployee;
      totals.siEm += r.totalInsuranceEmployer;
      totals.pit += r.pitAmount;
      await prisma.paySlip.create({
        data: {
          payRunId: payRun.id,
          employeeId: input.employeeId,
          workedDays: new Prisma.Decimal(input.attendance.workedDays.toFixed(3)),
          standardDays: new Prisma.Decimal(input.attendance.workedDays.toFixed(3)),
          nightHours: new Prisma.Decimal(input.attendance.nightHours.toFixed(2)),
          otWeekdayHours: new Prisma.Decimal(input.attendance.otWeekdayHours.toFixed(2)),
          otWeekendHours: new Prisma.Decimal(input.attendance.otWeekendHours.toFixed(2)),
          otHolidayHours: new Prisma.Decimal(input.attendance.otHolidayHours.toFixed(2)),
          hourlyRate: r.hourlyRate,
          gross: r.gross,
          allowances: r.earnings.filter((x) => !['BASE', 'KPI', 'COMMISSION'].includes(x.code)).reduce((a, b) => a + b.amount, 0),
          kpiAmount: r.earnings.find((x) => x.code === 'KPI')?.amount ?? 0,
          commission: r.earnings.find((x) => x.code === 'COMMISSION')?.amount ?? 0,
          nightAllowance: r.earnings.find((x) => x.code === 'NIGHT_ALLOWANCE')?.amount ?? 0,
          otAmount: r.earnings.filter((x) => x.code.startsWith('OT_')).reduce((a, b) => a + b.amount, 0),
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
          earningsDetail: { earnings: r.earnings, taxExempt: r.taxExemptTotal } as unknown as Prisma.InputJsonValue,
          deductionsDetail: { items: r.deductionItems, brackets: r.pit.brackets } as unknown as Prisma.InputJsonValue,
          selfDeduction: r.pit.deductions.self,
          dependentCount: r.pit.deductions.dependentCount,
          dependentDeduction: r.pit.deductions.dependents,
          pit: r.pitAmount,
          otherDeductions: r.totalDeductions - r.advance,
          advance: r.advance,
          net: r.net,
        },
      });
    } catch (err) {
      calcErrors.push({ code: input.employeeCode, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await prisma.payRun.update({
    where: { id: payRun.id },
    data: {
      totalGross: totals.gross,
      totalNet: totals.net,
      totalSiEmployee: totals.siE,
      totalSiEmployer: totals.siEm,
      totalPit: totals.pit,
      headcount: payrollInputs.length - calcErrors.length,
    },
  });

  console.log(
    `\n✓ BẢNG LƯƠNG ${regime.code} (${regime.name})`,
  );
  console.log(`  Số phiếu          : ${payrollInputs.length - calcErrors.length}`);
  console.log(`  Tổng lương gross  : ${totals.gross.toLocaleString('vi-VN')} ₫`);
  console.log(`  BHXH NLĐ (10.5%)  : ${totals.siE.toLocaleString('vi-VN')} ₫`);
  console.log(`  BHXH NSDLĐ (21.5%): ${totals.siEm.toLocaleString('vi-VN')} ₫`);
  console.log(`  Thuế TNCN         : ${totals.pit.toLocaleString('vi-VN')} ₫`);
  console.log(`  Thực lĩnh         : ${totals.net.toLocaleString('vi-VN')} ₫`);
  if (calcErrors.length > 0) {
    console.log(`  ⚠ ${calcErrors.length} lỗi tính lương:`);
    calcErrors.slice(0, 5).forEach((e) => console.log(`     - ${e.code}: ${e.error}`));
  }

  // --- 13. Đơn từ + chuỗi duyệt + nhật ký vết ---------------------------------------------
  const sampleRequests: Array<[string, RequestType, number, RequestStatus]> = [
    [employees[8]!.id, 'ANNUAL_LEAVE', 1, 'APPROVED'],
    [employees[9]!.id, 'ANNUAL_LEAVE', 2, 'PENDING_APPROVAL'],
    [employees[10]!.id, 'SICK_LEAVE', 4, 'PENDING_APPROVAL'],
    [employees[13]!.id, 'REGULARIZATION', 1, 'APPROVED'],
    [employees[14]!.id, 'BUSINESS_TRIP', 3, 'DRAFT'],
    [employees[15]!.id, 'UNPAID_LEAVE', 5, 'REJECTED'],
    [employees[16]!.id, 'MARRIAGE_LEAVE', 3, 'APPROVED'],
  ];
  let reqSeq = 0;
  for (const [empId, type, days, status] of sampleRequests) {
    reqSeq += 1;
    const emp = employees.find((e) => e.id === empId)!;
    const req = await prisma.leaveRequest.create({
      data: {
        requestNo: `LR${PERIOD_YEAR}${String(reqSeq).padStart(6, '0')}`,
        employeeId: empId,
        type,
        status,
        title: `${type} — ${emp.fullName}`,
        reason: 'Dữ liệu mẫu cho kiểm thử luồng duyệt',
        fromDate: new Date(`${dateAddDays(PERIOD_START, 5)}T00:00:00.000Z`),
        toDate: new Date(`${dateAddDays(PERIOD_START, 4 + days)}T00:00:00.000Z`),
        days: new Prisma.Decimal(days),
        hours: new Prisma.Decimal(days * 8),
        isPaid: type !== 'UNPAID_LEAVE',
        totalSteps: days >= 3 ? 4 : days >= 2 ? 2 : 1,
        submittedAt: status === 'DRAFT' ? null : new Date(),
      },
    });
    const chain =
      days >= 3
        ? (['DIRECT_MANAGER', 'DEPARTMENT_HEAD', 'HR_HEAD', 'CEO'] as const)
        : days >= 2
          ? (['DIRECT_MANAGER', 'DEPARTMENT_HEAD'] as const)
          : (['DIRECT_MANAGER'] as const);
    let step = 0;
    for (const approverType of chain) {
      step += 1;
      await prisma.approvalStep.create({
        data: {
          requestId: req.id,
          step,
          approverType,
          approverId: approverType === 'HR_HEAD' || approverType === 'CEO' ? userIds[approverType === 'CEO' ? 'tonggiamdoc' : 'hr.admin'] : null,
          approverName: approverType,
          status: status === 'APPROVED' ? 'APPROVED' : step === 1 ? 'PENDING_APPROVAL' : 'DRAFT',
        },
      });
    }
    await prisma.approvalAuditTrail.create({
      data: {
        requestId: req.id,
        actorId: emp.userId,
        actorName: emp.fullName,
        action: 'SUBMIT',
        fromStatus: 'DRAFT',
        toStatus: status === 'DRAFT' ? 'DRAFT' : 'PENDING_APPROVAL',
        ipAddress: '113.161.12.34',
        userAgent: 'seed-script/1.0',
      },
    });
  }
  console.log(`✓ ${sampleRequests.length} đơn từ (đủ các trạng thái) + chuỗi duyệt + nhật ký vết`);

  // --- 14. Thành phần lương động (Formula Builder) -------------------------------------------
  const components: Array<[string, string, 'EARNING' | 'DEDUCTION', ComponentCalcMode, string | null]> = [
    ['BASE', 'Lương cơ bản', 'EARNING', 'FIXED', null],
    ['KPI', 'Lương hiệu quả KPI', 'EARNING', 'FORMULA', 'round(maxKpiSalary * kpiScore / 100 * prorateRatio)'],
    ['MEAL', 'Phụ cấp ăn trưa', 'EARNING', 'PER_DAY', null],
    ['COMMISSION', 'Hoa hồng kinh doanh', 'EARNING', 'FROM_COMMISSION', null],
    ['NIGHT_ALLOWANCE', 'Phụ cấp làm đêm 30%', 'EARNING', 'FROM_ATTENDANCE', 'round(hourlyRate * 0.3 * nightHours)'],
    ['OT_WEEKDAY', 'OT ngày thường 150%', 'EARNING', 'FROM_ATTENDANCE', 'round(hourlyRate * 1.5 * otWeekdayHours)'],
    ['OT_WEEKEND', 'OT ngày nghỉ tuần 200%', 'EARNING', 'FROM_ATTENDANCE', 'round(hourlyRate * 2 * otWeekendHours)'],
    ['OT_HOLIDAY', 'OT ngày lễ 300%', 'EARNING', 'FROM_ATTENDANCE', 'round(hourlyRate * 3 * otHolidayHours)'],
    ['PENALTY_LATE', 'Trừ đi trễ', 'DEDUCTION', 'FORMULA', 'lateMinutes > 10 ? round(lateCount * 50000) : 0'],
    ['UNION_FEE', 'Đoàn phí công đoàn 1%', 'DEDUCTION', 'FORMULA', 'round(baseSalary * 0.01)'],
  ];
  let sort = 0;
  for (const [code, name, type, mode, formula] of components) {
    sort += 10;
    await prisma.salaryComponent.create({
      data: {
        code,
        name,
        type,
        calcMode: mode,
        amount: code === 'MEAL' ? 30_000 : 0,
        formula,
        isTaxable: !['NIGHT_ALLOWANCE', 'OT_WEEKDAY', 'OT_WEEKEND', 'OT_HOLIDAY'].includes(code),
        taxExemptCap: code === 'MEAL' ? 730_000 : null,
        sortOrder: sort,
        isSystem: true,
      },
    });
  }
  console.log(`✓ ${components.length} thành phần lương động`);

  // --- 15. Workflow định nghĩa ------------------------------------------------------------
  const workflows: Array<[string, string, RequestType[], object]> = [
    ['WF_LEAVE', 'Duyệt nghỉ phép', ['ANNUAL_LEAVE', 'SICK_LEAVE', 'UNPAID_LEAVE'], [
      { step: 1, approverType: 'DIRECT_MANAGER', slaHours: 24 },
      { step: 2, approverType: 'DEPARTMENT_HEAD', slaHours: 24, when: { field: 'days', op: '>=', value: 2 } },
      { step: 3, approverType: 'HR_HEAD', slaHours: 48, when: { field: 'days', op: '>=', value: 3 } },
      { step: 4, approverType: 'CEO', slaHours: 48, when: { field: 'days', op: '>=', value: 3 } },
    ]],
    ['WF_REGULARIZATION', 'Duyệt đơn giải trình', ['REGULARIZATION'], [
      { step: 1, approverType: 'DIRECT_MANAGER', slaHours: 24 },
      { step: 2, approverType: 'HR_HEAD', slaHours: 48 },
    ]],
    ['WF_TRIP', 'Duyệt đơn công tác', ['BUSINESS_TRIP'], [
      { step: 1, approverType: 'DIRECT_MANAGER', slaHours: 24 },
      { step: 2, approverType: 'DEPARTMENT_HEAD', slaHours: 24 },
      { step: 3, approverType: 'CHIEF_ACCOUNTANT', slaHours: 48, when: { field: 'amountVnd', op: '>', value: 5_000_000 } },
      { step: 4, approverType: 'CEO', slaHours: 48, when: { field: 'amountVnd', op: '>', value: 20_000_000 } },
    ]],
  ];
  for (const [code, name, types, steps] of workflows) {
    await prisma.workflowDefinition.create({
      data: {
        code,
        name,
        requestTypes: types,
        steps: steps as unknown as Prisma.InputJsonValue,
      },
    });
  }
  console.log(`✓ ${workflows.length} luồng duyệt`);

  console.log('\n=== SEED HOÀN TẤT ===');
  console.log(`Đăng nhập: admin / ${PASSWORD}  (SUPER_ADMIN)`);
  console.log(`           hr.admin / ${PASSWORD}  (HR_ADMIN)`);
  console.log(`           nv0001..nv${String(seq).padStart(4, '0')} / ${PASSWORD}  (nhân viên)\n`);
}

main()
  .catch((e) => {
    console.error('SEED THẤT BẠI:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
