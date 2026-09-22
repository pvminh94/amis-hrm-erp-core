-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'HR_ADMIN', 'HR_STAFF', 'DEPARTMENT_HEAD', 'DIRECT_LINE_MANAGER', 'ACCOUNTANT', 'CHIEF_ACCOUNTANT', 'CEO', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "DataScope" AS ENUM ('ALL_COMPANY', 'BRANCH', 'DEPARTMENT', 'SELF');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'LOCKED', 'PENDING', 'DELETED');

-- CreateEnum
CREATE TYPE "OrgUnitType" AS ENUM ('COMPANY', 'BRANCH', 'DEPARTMENT', 'TEAM');

-- CreateEnum
CREATE TYPE "CostCenterType" AS ENUM ('SELLING', 'ADMIN', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('PROBATION', 'ACTIVE', 'SUSPENDED', 'NOTICE', 'TERMINATED');

-- CreateEnum
CREATE TYPE "ContractType" AS ENUM ('INDEFINITE', 'FIXED_TERM', 'SEASONAL', 'PROBATION', 'COLLABORATOR');

-- CreateEnum
CREATE TYPE "WorkdayType" AS ENUM ('WORKING_DAY', 'WEEKLY_REST_DAY', 'PUBLIC_HOLIDAY', 'PAID_LEAVE_DAY', 'UNPAID_LEAVE_DAY', 'COMPANY_HOLIDAY');

-- CreateEnum
CREATE TYPE "ShiftType" AS ENUM ('OFFICE', 'NIGHT_CROSS_DAY', 'SPLIT', 'ROTATING', 'FLEXIBLE');

-- CreateEnum
CREATE TYPE "PunchSource" AS ENUM ('DEVICE_HIKVISION', 'DEVICE_RONALD_JACK', 'DEVICE_ZKTECO', 'MOBILE_GPS', 'MOBILE_FACE', 'WEB_MANUAL', 'IMPORT_CSV', 'ADMS_PUSH', 'ISAPI_LISTEN');

-- CreateEnum
CREATE TYPE "PunchDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT', 'LEAVE_PAID', 'LEAVE_UNPAID', 'BUSINESS_TRIP', 'MISSING_PUNCH', 'HALF_DAY', 'HOLIDAY_OFF', 'WEEKLY_OFF');

-- CreateEnum
CREATE TYPE "RequestType" AS ENUM ('ANNUAL_LEAVE', 'SICK_LEAVE', 'UNPAID_LEAVE', 'MATERNITY_LEAVE', 'BEREAVEMENT_LEAVE', 'MARRIAGE_LEAVE', 'BUSINESS_TRIP', 'REGULARIZATION', 'OVERTIME', 'SHIFT_SWAP', 'OTHER');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'RETURNED');

-- CreateEnum
CREATE TYPE "ApprovalAction" AS ENUM ('SUBMIT', 'APPROVE', 'REJECT', 'RETURN', 'CANCEL', 'REASSIGN', 'AUTO_APPROVE', 'ESCALATE');

-- CreateEnum
CREATE TYPE "PayRunStatus" AS ENUM ('DRAFT', 'LOCKED', 'APPROVED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ComponentType" AS ENUM ('EARNING', 'DEDUCTION');

-- CreateEnum
CREATE TYPE "ComponentCalcMode" AS ENUM ('FIXED', 'PER_DAY', 'PER_HOUR', 'PERCENT_BASE', 'PERCENT_CONTRACT', 'FORMULA', 'FROM_ATTENDANCE', 'FROM_COMMISSION');

-- CreateEnum
CREATE TYPE "JournalStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'DELIVERED', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BankCode" AS ENUM ('VCB', 'TCB', 'CTG', 'MBB', 'GENERIC');

-- CreateEnum
CREATE TYPE "QueueName" AS ENUM ('SYNC_RAW_PUNCH', 'CLOSE_NIGHT_SHIFT', 'SEND_PAYSLIP_MAIL', 'CALC_PROGRESSIVE_TAX', 'POST_GL_JOURNAL', 'EXPORT_PAYMENT_FILE', 'LIVENESS_RESCAN');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "email" VARCHAR(160) NOT NULL,
    "password_hash" VARCHAR(100) NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'EMPLOYEE',
    "data_scope" "DataScope" NOT NULL DEFAULT 'SELF',
    "scope_refs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMP(3),
    "last_login_ip" VARCHAR(64),
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret" VARCHAR(64),
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "family_id" UUID NOT NULL,
    "replaced_by" UUID,
    "user_agent" VARCHAR(255),
    "ip_address" VARCHAR(64),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" VARCHAR(128) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "module" VARCHAR(64) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "role" "UserRole" NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_units" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "type" "OrgUnitType" NOT NULL,
    "parent_id" UUID,
    "cost_center_type" "CostCenterType" NOT NULL DEFAULT 'ADMIN',
    "gl_expense_account" VARCHAR(16) NOT NULL DEFAULT '6422',
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "geofence_radius_m" INTEGER,
    "geofence_polygon" JSONB,
    "wifi_bssids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "manager_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "org_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "department_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "full_name" VARCHAR(160) NOT NULL,
    "gender" "Gender" NOT NULL DEFAULT 'MALE',
    "date_of_birth" DATE,
    "national_id_enc" VARCHAR(255) NOT NULL,
    "national_id_hint" VARCHAR(8) NOT NULL,
    "tax_code" VARCHAR(32),
    "bank_account_enc" VARCHAR(255),
    "bank_code" "BankCode" NOT NULL DEFAULT 'GENERIC',
    "bank_branch" VARCHAR(160),
    "phone" VARCHAR(24),
    "email" VARCHAR(160),
    "address" VARCHAR(255),
    "department_id" UUID,
    "position_id" UUID,
    "manager_id" UUID,
    "hire_date" DATE NOT NULL,
    "leave_date" DATE,
    "status" "EmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "wage_region" VARCHAR(2) NOT NULL DEFAULT 'I',
    "user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "biometric_enrollments" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "face_vector_enc" BYTEA NOT NULL,
    "face_vector_hash" VARCHAR(64) NOT NULL,
    "dimensions" INTEGER NOT NULL DEFAULT 512,
    "algorithm" VARCHAR(64) NOT NULL DEFAULT 'arcface-r100',
    "liveness_score" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "quality_score" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "biometric_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "contract_no" VARCHAR(32) NOT NULL,
    "employee_id" UUID NOT NULL,
    "type" "ContractType" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "base_salary" INTEGER NOT NULL,
    "contract_salary" INTEGER NOT NULL,
    "max_kpi_salary" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'VND',
    "probation_rate" DECIMAL(5,4) NOT NULL DEFAULT 0.85,
    "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "attachment_url" VARCHAR(512),
    "signed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_insurances" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "si_number" VARCHAR(32),
    "hi_number" VARCHAR(32),
    "enrolled_from" DATE NOT NULL,
    "enrolled_to" DATE,
    "is_si_mandatory" BOOLEAN NOT NULL DEFAULT true,
    "is_hi_mandatory" BOOLEAN NOT NULL DEFAULT true,
    "is_ui_mandatory" BOOLEAN NOT NULL DEFAULT true,
    "si_base_override" INTEGER,
    "suspend_unpaid_14" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "employee_insurances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dependents" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "full_name" VARCHAR(160) NOT NULL,
    "national_id_enc" VARCHAR(255),
    "relationship" VARCHAR(48) NOT NULL,
    "date_of_birth" DATE,
    "tax_code" VARCHAR(32),
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "proof_url" VARCHAR(512),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "dependents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_calendars" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "working_days" INTEGER[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "work_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_days" (
    "id" UUID NOT NULL,
    "calendar_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "type" "WorkdayType" NOT NULL,
    "label" VARCHAR(160),
    "is_paid" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "calendar_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_definitions" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "type" "ShiftType" NOT NULL,
    "standard_hours" DECIMAL(5,2) NOT NULL,
    "segment_count" INTEGER NOT NULL DEFAULT 1,
    "segments" JSONB NOT NULL,
    "cross_midnight" BOOLEAN NOT NULL DEFAULT false,
    "night_start_min" INTEGER NOT NULL DEFAULT 1320,
    "night_end_min" INTEGER NOT NULL DEFAULT 360,
    "night_premium_rate" DECIMAL(5,4) NOT NULL DEFAULT 0.3,
    "grace_minutes" INTEGER NOT NULL DEFAULT 10,
    "late_tolerance_min" INTEGER NOT NULL DEFAULT 0,
    "absent_after_late_min" INTEGER NOT NULL DEFAULT 240,
    "early_leave_tolerance_min" INTEGER NOT NULL DEFAULT 0,
    "allow_free_pairing" BOOLEAN NOT NULL DEFAULT false,
    "color_hex" VARCHAR(9) NOT NULL DEFAULT '#3b82f6',
    "calendar_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "shift_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rotation_patterns" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "pattern" JSONB NOT NULL,
    "cycle_length" INTEGER NOT NULL,
    "anchor_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "rotation_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_schedules" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "shift_id" UUID,
    "calendar_day_id" UUID,
    "rotation_pattern_id" UUID,
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "note" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "employee_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "protocol" VARCHAR(32) NOT NULL,
    "serial_number" VARCHAR(64) NOT NULL,
    "ip_address" VARCHAR(64),
    "port" INTEGER,
    "push_token" VARCHAR(128),
    "org_unit_id" UUID,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_heartbeat" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_punches" (
    "id" UUID NOT NULL,
    "employee_id" UUID,
    "device_user_id" VARCHAR(32),
    "device_id" UUID,
    "punch_at" TIMESTAMP(3) NOT NULL,
    "original_tz" VARCHAR(48) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    "direction" "PunchDirection",
    "source" "PunchSource" NOT NULL,
    "raw_payload" JSONB,
    "dedupe_hash" VARCHAR(64) NOT NULL,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "accuracy_m" INTEGER,
    "bssid" VARCHAR(32),
    "ssid" VARCHAR(64),
    "is_face_verified" BOOLEAN NOT NULL DEFAULT false,
    "similarity" DECIMAL(5,4),
    "liveness_score" DECIMAL(5,4),
    "liveness_detail" JSONB,
    "moire_peak_ratio" DECIMAL(8,5),
    "geofence_ok" BOOLEAN,
    "distance_m" INTEGER,
    "is_manual" BOOLEAN NOT NULL DEFAULT false,
    "is_void" BOOLEAN NOT NULL DEFAULT false,
    "void_reason" VARCHAR(255),
    "daily_attendance_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_punches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_attendances" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "shift_id" UUID,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'PRESENT',
    "check_in_at" TIMESTAMP(3),
    "check_out_at" TIMESTAMP(3),
    "segments" JSONB,
    "planned_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "worked_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "standard_days" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "late_minutes" INTEGER NOT NULL DEFAULT 0,
    "early_leave_minutes" INTEGER NOT NULL DEFAULT 0,
    "absent_minutes" INTEGER NOT NULL DEFAULT 0,
    "night_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "ot_weekday_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "ot_weekend_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "ot_holiday_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "ot_night_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "regularized_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "regularization_id" UUID,
    "last_computed_at" TIMESTAMP(3),
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "daily_attendances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_definitions" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "request_types" "RequestType"[],
    "priority" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "steps" JSONB NOT NULL,
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leave_requests" (
    "id" UUID NOT NULL,
    "request_no" VARCHAR(32) NOT NULL,
    "employee_id" UUID NOT NULL,
    "type" "RequestType" NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'DRAFT',
    "title" VARCHAR(160) NOT NULL,
    "reason" TEXT,
    "from_date" TIMESTAMP(3) NOT NULL,
    "to_date" TIMESTAMP(3) NOT NULL,
    "from_time_min" INTEGER NOT NULL DEFAULT 480,
    "to_time_min" INTEGER NOT NULL DEFAULT 1020,
    "days" DECIMAL(6,2) NOT NULL,
    "hours" DECIMAL(6,2) NOT NULL,
    "is_paid" BOOLEAN NOT NULL DEFAULT true,
    "regularization_date" DATE,
    "proposed_check_in" TIMESTAMP(3),
    "proposed_check_out" TIMESTAMP(3),
    "attachments" JSONB,
    "workflow_id" UUID,
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "total_steps" INTEGER NOT NULL DEFAULT 0,
    "submitted_at" TIMESTAMP(3),
    "decided_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "leave_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_steps" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "step" INTEGER NOT NULL,
    "approver_type" VARCHAR(32) NOT NULL,
    "approver_role" "UserRole",
    "approver_id" UUID,
    "approver_name" VARCHAR(160),
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "action" "ApprovalAction",
    "comment" VARCHAR(1000),
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(255),
    "acted_at" TIMESTAMP(3),
    "due_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_audit_trails" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "actor_id" UUID,
    "actor_name" VARCHAR(160),
    "actor_role" "UserRole",
    "action" "ApprovalAction" NOT NULL,
    "from_status" "RequestStatus",
    "to_status" "RequestStatus",
    "step" INTEGER,
    "comment" VARCHAR(1000),
    "ip_address" VARCHAR(64) NOT NULL,
    "user_agent" VARCHAR(255),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_audit_trails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_components" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "type" "ComponentType" NOT NULL,
    "calc_mode" "ComponentCalcMode" NOT NULL,
    "variable" VARCHAR(64),
    "amount" INTEGER NOT NULL DEFAULT 0,
    "rate" DECIMAL(6,4),
    "formula" TEXT,
    "is_taxable" BOOLEAN NOT NULL DEFAULT true,
    "is_si_base" BOOLEAN NOT NULL DEFAULT false,
    "tax_exempt_cap" INTEGER,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "salary_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_runs" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "period_year" INTEGER NOT NULL,
    "period_month" INTEGER NOT NULL,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "status" "PayRunStatus" NOT NULL DEFAULT 'DRAFT',
    "tax_regime_code" VARCHAR(32) NOT NULL,
    "policy_snapshot" JSONB NOT NULL,
    "org_unit_id" UUID,
    "total_gross" INTEGER NOT NULL DEFAULT 0,
    "total_net" INTEGER NOT NULL DEFAULT 0,
    "total_si_employee" INTEGER NOT NULL DEFAULT 0,
    "total_si_employer" INTEGER NOT NULL DEFAULT 0,
    "total_pit" INTEGER NOT NULL DEFAULT 0,
    "headcount" INTEGER NOT NULL DEFAULT 0,
    "locked_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "approved_by" TEXT,
    "paid_at" TIMESTAMP(3),
    "paid_by" TEXT,
    "gl_posted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "pay_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_slips" (
    "id" UUID NOT NULL,
    "pay_run_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "worked_days" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "standard_days" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "night_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "ot_weekday_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "ot_weekend_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "ot_holiday_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "hourly_rate" INTEGER NOT NULL DEFAULT 0,
    "gross" INTEGER NOT NULL DEFAULT 0,
    "allowances" INTEGER NOT NULL DEFAULT 0,
    "kpi_amount" INTEGER NOT NULL DEFAULT 0,
    "commission" INTEGER NOT NULL DEFAULT 0,
    "night_allowance" INTEGER NOT NULL DEFAULT 0,
    "ot_amount" INTEGER NOT NULL DEFAULT 0,
    "deductions" INTEGER NOT NULL DEFAULT 0,
    "si_base" INTEGER NOT NULL DEFAULT 0,
    "si_employee" INTEGER NOT NULL DEFAULT 0,
    "hi_employee" INTEGER NOT NULL DEFAULT 0,
    "ui_employee" INTEGER NOT NULL DEFAULT 0,
    "total_insurance_employee" INTEGER NOT NULL DEFAULT 0,
    "si_employer" INTEGER NOT NULL DEFAULT 0,
    "hi_employer" INTEGER NOT NULL DEFAULT 0,
    "ui_employer" INTEGER NOT NULL DEFAULT 0,
    "wci_employer" INTEGER NOT NULL DEFAULT 0,
    "total_insurance_employer" INTEGER NOT NULL DEFAULT 0,
    "taxable_income" INTEGER NOT NULL DEFAULT 0,
    "deductions_detail" JSONB,
    "earnings_detail" JSONB,
    "self_deduction" INTEGER NOT NULL DEFAULT 0,
    "dependent_count" INTEGER NOT NULL DEFAULT 0,
    "dependent_deduction" INTEGER NOT NULL DEFAULT 0,
    "pit" INTEGER NOT NULL DEFAULT 0,
    "other_deductions" INTEGER NOT NULL DEFAULT 0,
    "advance" INTEGER NOT NULL DEFAULT 0,
    "net" INTEGER NOT NULL DEFAULT 0,
    "payslip_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "pay_slips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "normal_side" VARCHAR(8) NOT NULL,
    "parent_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_centers" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "type" "CostCenterType" NOT NULL,
    "org_unit_id" UUID,
    "gl_account" VARCHAR(16) NOT NULL DEFAULT '6422',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "cost_centers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" UUID NOT NULL,
    "entry_no" VARCHAR(32) NOT NULL,
    "date" DATE NOT NULL,
    "description" VARCHAR(512) NOT NULL,
    "source_type" VARCHAR(32) NOT NULL,
    "source_id" UUID,
    "pay_run_id" UUID,
    "status" "JournalStatus" NOT NULL DEFAULT 'DRAFT',
    "posted_at" TIMESTAMP(3),
    "posted_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "account_code" VARCHAR(16) NOT NULL,
    "sub_account" VARCHAR(16),
    "debit" INTEGER NOT NULL DEFAULT 0,
    "credit" INTEGER NOT NULL DEFAULT 0,
    "cost_center_code" VARCHAR(32),
    "employee_id" UUID,
    "memo" VARCHAR(255),
    "line_no" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_files" (
    "id" UUID NOT NULL,
    "pay_run_id" UUID NOT NULL,
    "bank_code" "BankCode" NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_format" VARCHAR(16) NOT NULL,
    "checksum" VARCHAR(128) NOT NULL,
    "row_count" INTEGER NOT NULL,
    "total_amount" INTEGER NOT NULL,
    "storage_path" VARCHAR(512) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" UUID NOT NULL,
    "order_no" VARCHAR(32) NOT NULL,
    "employee_id" UUID,
    "customer_name" VARCHAR(160) NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "order_date" DATE NOT NULL,
    "revenue_date" DATE,
    "total_amount" INTEGER NOT NULL,
    "discount_amount" INTEGER NOT NULL DEFAULT 0,
    "tax_amount" INTEGER NOT NULL DEFAULT 0,
    "net_revenue" INTEGER NOT NULL,
    "gross_margin" INTEGER,
    "is_counted_for_commission" BOOLEAN NOT NULL DEFAULT false,
    "commission_run_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_policies" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "flat_rate" DECIMAL(6,4),
    "tiers" JSONB,
    "min_kpi_score" INTEGER,
    "cap_amount" INTEGER,
    "collection_factor" JSONB,
    "base_on" VARCHAR(16) NOT NULL DEFAULT 'REVENUE',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "commission_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_runs" (
    "id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "period_year" INTEGER NOT NULL,
    "period_month" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    "results" JSONB,
    "total_commission" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "commission_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "entity" VARCHAR(64) NOT NULL,
    "entity_id" VARCHAR(64),
    "before" JSONB,
    "after" JSONB,
    "ip_address" VARCHAR(64) NOT NULL,
    "user_agent" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "queue_jobs" (
    "id" UUID NOT NULL,
    "queue" "QueueName" NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "last_error" TEXT,
    "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "result" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queue_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "value" JSONB NOT NULL,
    "category" VARCHAR(64) NOT NULL DEFAULT 'general',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_data_scope_idx" ON "users"("data_scope");

-- CreateIndex
CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "permissions_module_idx" ON "permissions"("module");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_role_permission_id_key" ON "role_permissions"("role", "permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_units_code_key" ON "org_units"("code");

-- CreateIndex
CREATE INDEX "org_units_parent_id_idx" ON "org_units"("parent_id");

-- CreateIndex
CREATE INDEX "org_units_type_idx" ON "org_units"("type");

-- CreateIndex
CREATE INDEX "org_units_deleted_at_idx" ON "org_units"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "positions_code_key" ON "positions"("code");

-- CreateIndex
CREATE INDEX "positions_deleted_at_idx" ON "positions"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "employees_code_key" ON "employees"("code");

-- CreateIndex
CREATE UNIQUE INDEX "employees_user_id_key" ON "employees"("user_id");

-- CreateIndex
CREATE INDEX "employees_department_id_idx" ON "employees"("department_id");

-- CreateIndex
CREATE INDEX "employees_manager_id_idx" ON "employees"("manager_id");

-- CreateIndex
CREATE INDEX "employees_status_idx" ON "employees"("status");

-- CreateIndex
CREATE INDEX "employees_national_id_hint_idx" ON "employees"("national_id_hint");

-- CreateIndex
CREATE INDEX "employees_deleted_at_idx" ON "employees"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "biometric_enrollments_employee_id_key" ON "biometric_enrollments"("employee_id");

-- CreateIndex
CREATE INDEX "biometric_enrollments_face_vector_hash_idx" ON "biometric_enrollments"("face_vector_hash");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_contract_no_key" ON "contracts"("contract_no");

-- CreateIndex
CREATE INDEX "contracts_employee_id_start_date_idx" ON "contracts"("employee_id", "start_date");

-- CreateIndex
CREATE INDEX "contracts_deleted_at_idx" ON "contracts"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "employee_insurances_employee_id_key" ON "employee_insurances"("employee_id");

-- CreateIndex
CREATE INDEX "dependents_employee_id_valid_from_valid_to_idx" ON "dependents"("employee_id", "valid_from", "valid_to");

-- CreateIndex
CREATE INDEX "dependents_deleted_at_idx" ON "dependents"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "dependents_tax_code_valid_from_key" ON "dependents"("tax_code", "valid_from");

-- CreateIndex
CREATE UNIQUE INDEX "work_calendars_code_key" ON "work_calendars"("code");

-- CreateIndex
CREATE INDEX "work_calendars_deleted_at_idx" ON "work_calendars"("deleted_at");

-- CreateIndex
CREATE INDEX "calendar_days_date_idx" ON "calendar_days"("date");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_days_calendar_id_date_key" ON "calendar_days"("calendar_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "shift_definitions_code_key" ON "shift_definitions"("code");

-- CreateIndex
CREATE INDEX "shift_definitions_type_idx" ON "shift_definitions"("type");

-- CreateIndex
CREATE INDEX "shift_definitions_deleted_at_idx" ON "shift_definitions"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "rotation_patterns_code_key" ON "rotation_patterns"("code");

-- CreateIndex
CREATE INDEX "rotation_patterns_deleted_at_idx" ON "rotation_patterns"("deleted_at");

-- CreateIndex
CREATE INDEX "employee_schedules_work_date_idx" ON "employee_schedules"("work_date");

-- CreateIndex
CREATE INDEX "employee_schedules_shift_id_idx" ON "employee_schedules"("shift_id");

-- CreateIndex
CREATE INDEX "employee_schedules_deleted_at_idx" ON "employee_schedules"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "employee_schedules_employee_id_work_date_key" ON "employee_schedules"("employee_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "devices_code_key" ON "devices"("code");

-- CreateIndex
CREATE UNIQUE INDEX "devices_serial_number_key" ON "devices"("serial_number");

-- CreateIndex
CREATE INDEX "devices_org_unit_id_idx" ON "devices"("org_unit_id");

-- CreateIndex
CREATE INDEX "devices_deleted_at_idx" ON "devices"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "raw_punches_dedupe_hash_key" ON "raw_punches"("dedupe_hash");

-- CreateIndex
CREATE INDEX "raw_punches_employee_id_punch_at_idx" ON "raw_punches"("employee_id", "punch_at");

-- CreateIndex
CREATE INDEX "raw_punches_punch_at_idx" ON "raw_punches"("punch_at");

-- CreateIndex
CREATE INDEX "raw_punches_device_user_id_punch_at_idx" ON "raw_punches"("device_user_id", "punch_at");

-- CreateIndex
CREATE INDEX "raw_punches_daily_attendance_id_idx" ON "raw_punches"("daily_attendance_id");

-- CreateIndex
CREATE INDEX "daily_attendances_work_date_idx" ON "daily_attendances"("work_date");

-- CreateIndex
CREATE INDEX "daily_attendances_status_idx" ON "daily_attendances"("status");

-- CreateIndex
CREATE INDEX "daily_attendances_deleted_at_idx" ON "daily_attendances"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "daily_attendances_employee_id_work_date_key" ON "daily_attendances"("employee_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_definitions_code_key" ON "workflow_definitions"("code");

-- CreateIndex
CREATE INDEX "workflow_definitions_deleted_at_idx" ON "workflow_definitions"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "leave_requests_request_no_key" ON "leave_requests"("request_no");

-- CreateIndex
CREATE INDEX "leave_requests_employee_id_from_date_to_date_idx" ON "leave_requests"("employee_id", "from_date", "to_date");

-- CreateIndex
CREATE INDEX "leave_requests_status_idx" ON "leave_requests"("status");

-- CreateIndex
CREATE INDEX "leave_requests_type_status_idx" ON "leave_requests"("type", "status");

-- CreateIndex
CREATE INDEX "leave_requests_deleted_at_idx" ON "leave_requests"("deleted_at");

-- CreateIndex
CREATE INDEX "approval_steps_approver_id_status_idx" ON "approval_steps"("approver_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "approval_steps_request_id_step_key" ON "approval_steps"("request_id", "step");

-- CreateIndex
CREATE INDEX "approval_audit_trails_request_id_created_at_idx" ON "approval_audit_trails"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "approval_audit_trails_actor_id_idx" ON "approval_audit_trails"("actor_id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_components_code_key" ON "salary_components"("code");

-- CreateIndex
CREATE INDEX "salary_components_type_sort_order_idx" ON "salary_components"("type", "sort_order");

-- CreateIndex
CREATE INDEX "salary_components_deleted_at_idx" ON "salary_components"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "pay_runs_code_key" ON "pay_runs"("code");

-- CreateIndex
CREATE INDEX "pay_runs_status_idx" ON "pay_runs"("status");

-- CreateIndex
CREATE INDEX "pay_runs_deleted_at_idx" ON "pay_runs"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "pay_runs_period_year_period_month_org_unit_id_key" ON "pay_runs"("period_year", "period_month", "org_unit_id");

-- CreateIndex
CREATE INDEX "pay_slips_employee_id_idx" ON "pay_slips"("employee_id");

-- CreateIndex
CREATE INDEX "pay_slips_deleted_at_idx" ON "pay_slips"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "pay_slips_pay_run_id_employee_id_key" ON "pay_slips"("pay_run_id", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_code_key" ON "accounts"("code");

-- CreateIndex
CREATE INDEX "accounts_type_idx" ON "accounts"("type");

-- CreateIndex
CREATE INDEX "accounts_deleted_at_idx" ON "accounts"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centers_code_key" ON "cost_centers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centers_org_unit_id_key" ON "cost_centers"("org_unit_id");

-- CreateIndex
CREATE INDEX "cost_centers_deleted_at_idx" ON "cost_centers"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "journal_entries_entry_no_key" ON "journal_entries"("entry_no");

-- CreateIndex
CREATE INDEX "journal_entries_date_idx" ON "journal_entries"("date");

-- CreateIndex
CREATE INDEX "journal_entries_source_type_source_id_idx" ON "journal_entries"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "journal_entries_deleted_at_idx" ON "journal_entries"("deleted_at");

-- CreateIndex
CREATE INDEX "journal_lines_entry_id_line_no_idx" ON "journal_lines"("entry_id", "line_no");

-- CreateIndex
CREATE INDEX "journal_lines_account_code_idx" ON "journal_lines"("account_code");

-- CreateIndex
CREATE INDEX "payment_files_pay_run_id_idx" ON "payment_files"("pay_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_order_no_key" ON "sales_orders"("order_no");

-- CreateIndex
CREATE INDEX "sales_orders_employee_id_order_date_idx" ON "sales_orders"("employee_id", "order_date");

-- CreateIndex
CREATE INDEX "sales_orders_status_revenue_date_idx" ON "sales_orders"("status", "revenue_date");

-- CreateIndex
CREATE INDEX "sales_orders_deleted_at_idx" ON "sales_orders"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "commission_policies_code_key" ON "commission_policies"("code");

-- CreateIndex
CREATE INDEX "commission_policies_deleted_at_idx" ON "commission_policies"("deleted_at");

-- CreateIndex
CREATE INDEX "commission_runs_deleted_at_idx" ON "commission_runs"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "commission_runs_policy_id_period_year_period_month_key" ON "commission_runs"("policy_id", "period_year", "period_month");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entity_id_idx" ON "audit_logs"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "queue_jobs_queue_status_run_at_idx" ON "queue_jobs"("queue", "status", "run_at");

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_units" ADD CONSTRAINT "org_units_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "org_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "org_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "org_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "biometric_enrollments" ADD CONSTRAINT "biometric_enrollments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_insurances" ADD CONSTRAINT "employee_insurances_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dependents" ADD CONSTRAINT "dependents_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_days" ADD CONSTRAINT "calendar_days_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "work_calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_definitions" ADD CONSTRAINT "shift_definitions_calendar_id_fkey" FOREIGN KEY ("calendar_id") REFERENCES "work_calendars"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_schedules" ADD CONSTRAINT "employee_schedules_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_schedules" ADD CONSTRAINT "employee_schedules_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shift_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_org_unit_id_fkey" FOREIGN KEY ("org_unit_id") REFERENCES "org_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_punches" ADD CONSTRAINT "raw_punches_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_punches" ADD CONSTRAINT "raw_punches_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_punches" ADD CONSTRAINT "raw_punches_daily_attendance_id_fkey" FOREIGN KEY ("daily_attendance_id") REFERENCES "daily_attendances"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_attendances" ADD CONSTRAINT "daily_attendances_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_attendances" ADD CONSTRAINT "daily_attendances_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shift_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_attendances" ADD CONSTRAINT "daily_attendances_regularization_id_fkey" FOREIGN KEY ("regularization_id") REFERENCES "leave_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflow_definitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "leave_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_slips" ADD CONSTRAINT "pay_slips_pay_run_id_fkey" FOREIGN KEY ("pay_run_id") REFERENCES "pay_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_slips" ADD CONSTRAINT "pay_slips_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_centers" ADD CONSTRAINT "cost_centers_org_unit_id_fkey" FOREIGN KEY ("org_unit_id") REFERENCES "org_units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_pay_run_id_fkey" FOREIGN KEY ("pay_run_id") REFERENCES "pay_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_files" ADD CONSTRAINT "payment_files_pay_run_id_fkey" FOREIGN KEY ("pay_run_id") REFERENCES "pay_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_commission_run_id_fkey" FOREIGN KEY ("commission_run_id") REFERENCES "commission_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_runs" ADD CONSTRAINT "commission_runs_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "commission_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

