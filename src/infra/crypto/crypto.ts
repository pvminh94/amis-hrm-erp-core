/**
 * ============================================================================
 * MÃ HOÁ DỮ LIỆU NHẠY CẢM — AES-256-GCM
 * ============================================================================
 *
 * Dùng cho: CCCD/số hộ chiếu, số tài khoản ngân hàng, vector khuôn mặt 512D.
 *
 * Định dạng bản mã (base64):  <iv 12B> | <authTag 16B> | <ciphertext>
 * Mỗi lần mã hoá dùng IV NGẪU NHIÊN mới — cùng plaintext cho ra ciphertext
 * khác nhau, chống phân tích tần suất.
 *
 * Vector khuôn mặt: Float32Array(512) = 2048 bytes plaintext. Lưu kèm
 * SHA-256 của vector gốc để tra cứu 1:N mà không cần giải mã toàn bộ bảng.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

/** Nạp khoá từ biến môi trường (hex 64 ký tự = 32 bytes) */
export function loadKey(hexOrBase64: string | undefined, varName = 'DATA_ENCRYPTION_KEY'): Buffer {
  if (!hexOrBase64) {
    throw new CryptoError(`Thiếu biến môi trường ${varName}`);
  }
  const fromHex = Buffer.from(hexOrBase64, 'hex');
  if (fromHex.length === 32) return fromHex;
  const fromB64 = Buffer.from(hexOrBase64, 'base64');
  if (fromB64.length === 32) return fromB64;
  throw new CryptoError(
    `${varName} phải là 32 bytes (hex 64 ký tự hoặc base64). Nhận độ dài hex=${fromHex.length}, base64=${fromB64.length}`,
  );
}

export interface EncryptedPayload {
  /** base64 của iv|tag|ciphertext */
  cipher: string;
  /** SHA-256 hex của plaintext — dùng tra cứu mà không giải mã */
  hash: string;
}

export function encrypt(plaintext: string | Buffer, key: Buffer): EncryptedPayload {
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    cipher: Buffer.concat([iv, tag, enc]).toString('base64'),
    hash: sha256Hex(data),
  };
}

export function decryptToBuffer(cipherB64: string, key: Buffer): Buffer {
  const raw = Buffer.from(cipherB64, 'base64');
  if (raw.length < IV_LEN + TAG_LEN) {
    throw new CryptoError('Bản mã quá ngắn — không đúng định dạng iv|tag|ciphertext');
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new CryptoError('Giải mã thất bại — khoá sai hoặc bản mã đã bị sửa (GCM auth fail)');
  }
}

export function decrypt(cipherB64: string, key: Buffer): string {
  return decryptToBuffer(cipherB64, key).toString('utf8');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Nạp bcryptjs.
 *
 * `bcryptjs` là module CJS chỉ export `default` — KHÔNG có named export.
 * Nên `await import('bcryptjs')` trả về module NAMESPACE, trong đó `.hash`
 * là `undefined` còn `.default.hash` mới là hàm thật.
 *
 * Vitest/Vite tự trải `default` ra namespace nên code cũ vẫn chạy xanh trong
 * test, nhưng `node dist/...` thật thì nổ "bcrypt.hash is not a function" —
 * tức là hỏng luôn đăng nhập trên production. Vì vậy phải lấy qua `.default`
 * và fallback cho trường hợp bundler đã trải sẵn.
 */
async function loadBcrypt(): Promise<{
  hash: (plain: string, rounds: number) => Promise<string>;
  compare: (plain: string, hash: string) => Promise<boolean>;
}> {
  const ns = (await import('bcryptjs')) as unknown as {
    default?: { hash: (p: string, r: number) => Promise<string>; compare: (p: string, h: string) => Promise<boolean> };
    hash?: (p: string, r: number) => Promise<string>;
    compare?: (p: string, h: string) => Promise<boolean>;
  };
  const lib = (ns.default ?? ns) as { hash?: unknown; compare?: unknown };
  if (typeof lib.hash !== 'function' || typeof lib.compare !== 'function') {
    throw new Error('Không nạp được bcryptjs — kiểm tra lại dependency');
  }
  return lib as { hash: (p: string, r: number) => Promise<string>; compare: (p: string, h: string) => Promise<boolean> };
}

/** Hash mật khẩu — bcrypt với salt rounds cấu hình (mặc định 10) */
export async function hashPassword(plain: string, saltRounds = 10): Promise<string> {
  const bcrypt = await loadBcrypt();
  return bcrypt.hash(plain, saltRounds);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  const bcrypt = await loadBcrypt();
  return bcrypt.compare(plain, hash);
}

/** So sánh chuỗi chống timing attack */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// VECTOR KHUÔN MẶT 512D
// ---------------------------------------------------------------------------

export const FACE_VECTOR_DIMENSIONS = 512;

/** Serialise Float32Array -> Buffer (little-endian, 4 byte/số) */
export function serializeFaceVector(vec: Float32Array | number[]): Buffer {
  const arr = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  if (arr.length !== FACE_VECTOR_DIMENSIONS) {
    throw new CryptoError(
      `Vector khuôn mặt phải có ${FACE_VECTOR_DIMENSIONS} chiều, nhận ${arr.length}`,
    );
  }
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function deserializeFaceVector(buf: Buffer): Float32Array {
  if (buf.length !== FACE_VECTOR_DIMENSIONS * 4) {
    throw new CryptoError(
      `Buffer vector phải dài ${FACE_VECTOR_DIMENSIONS * 4} bytes, nhận ${buf.length}`,
    );
  }
  // Copy ra buffer mới để tránh lỗi căn lề byteOffset
  const copy = Buffer.allocUnsafe(buf.length);
  buf.copy(copy);
  return new Float32Array(copy.buffer, 0, FACE_VECTOR_DIMENSIONS);
}

/** Mã hoá vector khuôn mặt để lưu DB */
export function encryptFaceVector(vec: Float32Array | number[], key: Buffer): EncryptedPayload {
  return encrypt(serializeFaceVector(vec), key);
}

export function decryptFaceVector(cipherB64: string, key: Buffer): Float32Array {
  return deserializeFaceVector(decryptToBuffer(cipherB64, key));
}

/** Chuẩn hoá vector về độ dài đơn vị (bắt buộc trước khi tính cosine) */
export function normalizeVector(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i += 1) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i]! / norm;
  return out;
}

/**
 * Điểm tương đồng cosine giữa 2 vector (−1..1).
 * ArcFace thường dùng ngưỡng ~0.4 (cosine) để coi là cùng người.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new CryptoError(`Hai vector khác chiều: ${a.length} vs ${b.length}`);
  }
  const na = normalizeVector(a);
  const nb = normalizeVector(b);
  let dot = 0;
  for (let i = 0; i < na.length; i += 1) dot += na[i]! * nb[i]!;
  return dot;
}

/** Khoảng cách Euclid — dùng khi model xuất ra embedding đã L2-normalise */
export function euclideanDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new CryptoError(`Hai vector khác chiều: ${a.length} vs ${b.length}`);
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}
