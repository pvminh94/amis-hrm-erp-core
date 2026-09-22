/**
 * ============================================================================
 * DYNAMIC FORMULA BUILDER — bộ công thức lương động
 * ============================================================================
 *
 * Cho phép HR tự định nghĩa thành phần lương bằng biểu thức, vd:
 *   "round(baseSalary * kpiScore / 100)"
 *   "round(hourlyRate * workedDays * 8)"
 *   "min(commissionRevenue * 0.03, commissionCap)"
 *   "lateMinutes > 10 ? round(lateCount * 50000) : 0"
 *
 * AN TOÀN: KHÔNG dùng eval/Function. Đây là một máy tính biểu thức đầy đủ
 * (tokenizer -> Pratt/recursive-descent parser -> AST -> evaluator) chạy trên
 * tập biến được khai báo tường minh. Không có truy cập đối tượng, không có
 * gán, không có vòng lặp, không có truy cập global.
 *
 * Ngữ pháp (độ ưu tiên từ thấp đến cao):
 *   expr        := ternary
 *   ternary     := or ( '?' expr ':' expr )?
 *   or          := and ( '||' and )*
 *   and         := equality ( '&&' equality )*
 *   equality    := comparison ( ('==' | '!=') comparison )*
 *   comparison  := additive ( ('<' | '<=' | '>' | '>=') additive )*
 *   additive    := multiplicative ( ('+' | '-') multiplicative )*
 *   multiplicative := unary ( ('*' | '/' | '%') unary )*
 *   unary       := ('-' | '!') unary | power
 *   power       := primary ( '^' unary )?
 *   primary     := NUMBER | IDENT | IDENT '(' args ')' | '(' expr ')'
 */

export type FormulaValue = number | boolean | null;

export interface FormulaContext {
  [key: string]: number | boolean | null | undefined;
}

export type AstNode =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'call'; name: string; args: AstNode[] }
  | { kind: 'unary'; op: '-' | '!'; operand: AstNode }
  | { kind: 'binary'; op: string; left: AstNode; right: AstNode }
  | { kind: 'ternary'; cond: AstNode; then: AstNode; else: AstNode };

// ---------------------------------------------------------------------------
// TOKENIZER
// ---------------------------------------------------------------------------

type TokenType = 'num' | 'ident' | 'op' | 'paren' | 'comma' | 'question' | 'colon' | 'eof';
interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const MULTI_CHAR_OPS = ['<=', '>=', '==', '!=', '&&', '||'];
const SINGLE_CHAR_OPS = ['+', '-', '*', '/', '%', '^', '<', '>', '!'];

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j]!)) j += 1;
      const raw = src.slice(i, j).replace(/_/g, '');
      if (!/^\d*\.?\d+$/.test(raw)) {
        throw new FormulaError(`Số không hợp lệ "${raw}" tại vị trí ${i}`, i);
      }
      tokens.push({ type: 'num', value: raw, pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j]!)) j += 1;
      tokens.push({ type: 'ident', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch, pos: i });
      i += 1;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma', value: ch, pos: i });
      i += 1;
      continue;
    }
    if (ch === '?') {
      tokens.push({ type: 'question', value: ch, pos: i });
      i += 1;
      continue;
    }
    if (ch === ':') {
      tokens.push({ type: 'colon', value: ch, pos: i });
      i += 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (MULTI_CHAR_OPS.includes(two)) {
      tokens.push({ type: 'op', value: two, pos: i });
      i += 2;
      continue;
    }
    if (SINGLE_CHAR_OPS.includes(ch)) {
      tokens.push({ type: 'op', value: ch, pos: i });
      i += 1;
      continue;
    }
    throw new FormulaError(`Ký tự không hợp lệ "${ch}" tại vị trí ${i}`, i);
  }
  tokens.push({ type: 'eof', value: '', pos: src.length });
  return tokens;
}

export class FormulaError extends Error {
  pos: number;
  constructor(message: string, pos = -1) {
    super(pos >= 0 ? `${message}` : message);
    this.name = 'FormulaError';
    this.pos = pos;
  }
}

// ---------------------------------------------------------------------------
// PARSER (recursive descent)
// ---------------------------------------------------------------------------

export class Parser {
  private tokens: Token[];
  private idx = 0;

  constructor(private readonly src: string) {
    this.tokens = tokenize(src);
  }

  private peek(): Token {
    return this.tokens[this.idx]!;
  }
  private next(): Token {
    return this.tokens[this.idx++]!;
  }
  private expect(type: TokenType, value?: string): Token {
    const t = this.peek();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new FormulaError(
        `Kỳ vọng ${value ?? type} nhưng gặp "${t.value || 'hết biểu thức'}" tại vị trí ${t.pos}`,
        t.pos,
      );
    }
    return this.next();
  }
  private matchOp(...ops: string[]): Token | null {
    const t = this.peek();
    if (t.type === 'op' && ops.includes(t.value)) return this.next();
    return null;
  }

  parse(): AstNode {
    const node = this.parseTernary();
    const t = this.peek();
    if (t.type !== 'eof') {
      throw new FormulaError(`Biểu thức thừa "${t.value}" tại vị trí ${t.pos}`, t.pos);
    }
    return node;
  }

  private parseTernary(): AstNode {
    const cond = this.parseOr();
    if (this.peek().type === 'question') {
      this.next();
      const then = this.parseTernary();
      this.expect('colon');
      const els = this.parseTernary();
      return { kind: 'ternary', cond, then, else: els };
    }
    return cond;
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (this.matchOp('||')) left = { kind: 'binary', op: '||', left, right: this.parseAnd() };
    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseEquality();
    while (this.matchOp('&&')) left = { kind: 'binary', op: '&&', left, right: this.parseEquality() };
    return left;
  }

  private parseEquality(): AstNode {
    let left = this.parseComparison();
    for (;;) {
      const t = this.matchOp('==', '!=');
      if (!t) break;
      left = { kind: 'binary', op: t.value, left, right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): AstNode {
    let left = this.parseAdditive();
    for (;;) {
      const t = this.matchOp('<', '<=', '>', '>=');
      if (!t) break;
      left = { kind: 'binary', op: t.value, left, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): AstNode {
    let left = this.parseMultiplicative();
    for (;;) {
      const t = this.matchOp('+', '-');
      if (!t) break;
      left = { kind: 'binary', op: t.value, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): AstNode {
    let left = this.parseUnary();
    for (;;) {
      const t = this.matchOp('*', '/', '%');
      if (!t) break;
      left = { kind: 'binary', op: t.value, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): AstNode {
    const t = this.matchOp('-', '!');
    if (t) return { kind: 'unary', op: t.value as '-' | '!', operand: this.parseUnary() };
    return this.parsePower();
  }

  private parsePower(): AstNode {
    const base = this.parsePrimary();
    const t = this.matchOp('^');
    if (t) return { kind: 'binary', op: '^', left: base, right: this.parseUnary() };
    return base;
  }

  private parsePrimary(): AstNode {
    const t = this.peek();
    if (t.type === 'num') {
      this.next();
      return { kind: 'num', value: Number(t.value) };
    }
    if (t.type === 'paren' && t.value === '(') {
      this.next();
      const inner = this.parseTernary();
      this.expect('paren', ')');
      return inner;
    }
    if (t.type === 'ident') {
      this.next();
      if (this.peek().type === 'paren' && this.peek().value === '(') {
        this.next();
        const args: AstNode[] = [];
        if (!(this.peek().type === 'paren' && this.peek().value === ')')) {
          args.push(this.parseTernary());
          while (this.peek().type === 'comma') {
            this.next();
            args.push(this.parseTernary());
          }
        }
        this.expect('paren', ')');
        return { kind: 'call', name: t.value, args };
      }
      return { kind: 'var', name: t.value };
    }
    throw new FormulaError(
      `Biểu thức không hợp lệ tại "${t.value || 'hết biểu thức'}" (vị trí ${t.pos})`,
      t.pos,
    );
  }
}

// ---------------------------------------------------------------------------
// HÀM CÓ SẴN TRONG CÔNG THỨC
// ---------------------------------------------------------------------------

export interface FormulaFunction {
  arity: [number, number]; // [min, max]
  fn: (...args: number[]) => number;
}

/** Làm tròn half-up về đồng */
function fRound(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.sign(v || 1) * Math.floor(Math.abs(v) + 0.5);
}

export const FORMULA_FUNCTIONS: Record<string, FormulaFunction> = {
  round: { arity: [1, 1], fn: (v) => fRound(v) },
  round1000: { arity: [1, 1], fn: (v) => Math.floor(v / 1000) * 1000 },
  floor: { arity: [1, 1], fn: (v) => Math.floor(v) },
  ceil: { arity: [1, 1], fn: (v) => Math.ceil(v) },
  abs: { arity: [1, 1], fn: (v) => Math.abs(v) },
  min: { arity: [2, 8], fn: (...a) => Math.min(...a) },
  max: { arity: [2, 8], fn: (...a) => Math.max(...a) },
  clamp: { arity: [3, 3], fn: (v, lo, hi) => Math.min(Math.max(v, lo), hi) },
  pow: { arity: [2, 2], fn: (a, b) => a ** b },
  sqrt: { arity: [1, 1], fn: (v) => Math.sqrt(v) },
  /** Giới hạn trên — vd cap(x, 5000000) */
  cap: { arity: [2, 2], fn: (v, c) => Math.min(v, c) },
  /** Giới hạn dưới */
  floorAt: { arity: [2, 2], fn: (v, c) => Math.max(v, c) },
  /** Bậc thang luỹ tiến: tier(value, a1,r1, a2,r2, ...) */
  tier: {
    arity: [3, 20],
    fn: (value, ...pairs) => {
      if (pairs.length % 2 !== 0) throw new FormulaError('tier() cần số tham số chẵn (ngưỡng, tỷ lệ)');
      let result = 0;
      let prev = 0;
      for (let i = 0; i < pairs.length; i += 2) {
        const threshold = pairs[i]!;
        const rate = pairs[i + 1]!;
        const portion = Math.min(value, threshold) - prev;
        if (portion > 0) result += portion * rate;
        prev = threshold;
        if (value <= threshold) break;
      }
      const lastRate = pairs[pairs.length - 1]!;
      if (value > prev) result += (value - prev) * lastRate;
      return result;
    },
  },
  /** if(cond, a, b) — dạng hàm của toán tử ba ngôi */
  if: { arity: [3, 3], fn: (c, a, b) => (c !== 0 ? a : b) },
};

// ---------------------------------------------------------------------------
// EVALUATOR
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  /** Biến chưa khai báo xử lý thế nào */
  onMissingVar?: 'zero' | 'throw';
  /** Số lần bước tối đa để chống biểu thức bệnh lý */
  maxSteps?: number;
}

const DEFAULT_EVAL_OPTIONS: Required<EvaluateOptions> = {
  onMissingVar: 'zero',
  maxSteps: 100_000,
};

function toNumber(v: FormulaValue | undefined): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function evaluateAst(
  node: AstNode,
  ctx: FormulaContext,
  opts: EvaluateOptions = {},
): FormulaValue {
  const o = { ...DEFAULT_EVAL_OPTIONS, ...opts };
  let steps = 0;

  const visit = (n: AstNode): FormulaValue => {
    steps += 1;
    if (steps > o.maxSteps) throw new FormulaError('Biểu thức vượt giới hạn độ phức tạp');

    switch (n.kind) {
      case 'num':
        return n.value;
      case 'var': {
        if (!(n.name in ctx)) {
          if (o.onMissingVar === 'throw') {
            throw new FormulaError(`Biến "${n.name}" chưa được khai báo`);
          }
          return 0;
        }
        return ctx[n.name] ?? 0;
      }
      case 'unary': {
        const v = toNumber(visit(n.operand));
        return n.op === '-' ? -v : v === 0 ? true : false;
      }
      case 'ternary': {
        const c = visit(n.cond);
        const truthy = typeof c === 'boolean' ? c : toNumber(c) !== 0;
        return visit(truthy ? n.then : n.else);
      }
      case 'binary': {
        // short-circuit cho && và ||
        if (n.op === '&&' || n.op === '||') {
          const l = visit(n.left);
          const lt = typeof l === 'boolean' ? l : toNumber(l) !== 0;
          if (n.op === '&&' && !lt) return false;
          if (n.op === '||' && lt) return true;
          const r = visit(n.right);
          return typeof r === 'boolean' ? r : toNumber(r) !== 0;
        }
        if (n.op === '==' || n.op === '!=') {
          const l = visit(n.left);
          const r = visit(n.right);
          const eq = toNumber(l) === toNumber(r);
          return n.op === '==' ? eq : !eq;
        }
        const a = toNumber(visit(n.left));
        const b = toNumber(visit(n.right));
        switch (n.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/':
            if (b === 0) return 0; // tránh chia 0 trong công thức lương
            return a / b;
          case '%':
            if (b === 0) return 0;
            return a % b;
          case '^': return a ** b;
          case '<': return a < b;
          case '<=': return a <= b;
          case '>': return a > b;
          case '>=': return a >= b;
          default:
            throw new FormulaError(`Toán tử không hỗ trợ: ${n.op}`);
        }
      }
      case 'call': {
        const def = FORMULA_FUNCTIONS[n.name];
        if (!def) throw new FormulaError(`Hàm "${n.name}" không tồn tại trong bộ công thức`);
        if (n.args.length < def.arity[0] || n.args.length > def.arity[1]) {
          throw new FormulaError(
            `Hàm "${n.name}" cần ${def.arity[0]}-${def.arity[1]} tham số, nhận ${n.args.length}`,
          );
        }
        const args = n.args.map((a) => toNumber(visit(a)));
        return def.fn(...args);
      }
      default:
        throw new FormulaError('Nút AST không xác định');
    }
  };

  return visit(node);
}

// ---------------------------------------------------------------------------
// API CÔNG KHAI
// ---------------------------------------------------------------------------

const astCache = new Map<string, AstNode>();

/** Compile (có cache) một biểu thức thành AST */
export function compileFormula(src: string): AstNode {
  const cached = astCache.get(src);
  if (cached) return cached;
  if (!src || src.trim() === '') throw new FormulaError('Biểu thức rỗng');
  const ast = new Parser(src).parse();
  if (astCache.size > 5000) astCache.clear();
  astCache.set(src, ast);
  return ast;
}

/** Tính giá trị biểu thức. Kết quả luôn là số (boolean => 1/0). */
export function evalFormula(src: string, ctx: FormulaContext, opts?: EvaluateOptions): number {
  const v = evaluateAst(compileFormula(src), ctx, opts);
  return toNumber(v);
}

/** Liệt kê các biến được tham chiếu trong biểu thức — dùng để validate cấu hình */
export function extractVariables(src: string): string[] {
  const names = new Set<string>();
  const walk = (n: AstNode) => {
    switch (n.kind) {
      case 'var':
        names.add(n.name);
        break;
      case 'unary':
        walk(n.operand);
        break;
      case 'ternary':
        walk(n.cond);
        walk(n.then);
        walk(n.else);
        break;
      case 'binary':
        walk(n.left);
        walk(n.right);
        break;
      case 'call':
        n.args.forEach(walk);
        break;
      default:
        break;
    }
  };
  walk(compileFormula(src));
  return [...names];
}

/** Kiểm tra biểu thức hợp lệ — trả về lỗi nếu có */
export function validateFormula(src: string): { ok: boolean; error?: string; variables: string[] } {
  try {
    const variables = extractVariables(src);
    return { ok: true, variables };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), variables: [] };
  }
}
