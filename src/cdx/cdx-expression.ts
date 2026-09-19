/**
 * A small, extensible evaluator for the subset of the xBase/FoxPro expression language used by CDX
 * index keys and FOR filters.
 *
 * Supported syntax:
 * - Field references (case-insensitive identifiers).
 * - String literals ('...' or "..." with doubled-quote escaping), numeric literals, date/datetime
 *   literals ({^YYYY-MM-DD[ HH:MM:SS]}), logical literals (.T./.F.), and function calls.
 * - Operators: + - * / % ^, comparisons (= == <> != < > <= >=), $ (contains), .AND. .OR. .NOT.
 *   (also AND/OR/NOT), unary signs and parentheses.
 *
 * Functions are held in a registry that callers can extend via {@link registerCdxFunction}. Unsupported
 * functions raise a descriptive error rather than silently returning a wrong key.
 */




import {CdxKeyType, ExpressionCompat} from './cdx-format';




/** A value produced or consumed by an expression. */
export type CdxValue = string | number | boolean | Date | null;




/** Options controlling how an expression is parsed and evaluated. */
export interface CdxExpressionOptions {

    /**
     * The expression-compatibility mode. In `codebase` mode, `RIGHT(x, n)` is evaluated as the
     * leftmost `n` characters (matching Sequiter CodeBase, which aliases `RIGHT` to `LEFT`/`SUBSTR`
     * for variable/subexpression arguments). Defaults to `standard`.
     */
    compat?: ExpressionCompat;
}




/** The evaluation context: field lookup and the record's deleted state. */
export interface CdxEvalContext {

    /** Returns a field's value, or null when the field is not present. */
    getField(name: string): CdxValue;

    /** Whether the current record is marked deleted (used by `DELETED()`). */
    isDeleted(): boolean;
}




/** A registered function implementation. */
export type CdxFunction = (args: CdxValue[], context: CdxEvalContext) => CdxValue;




const functions = new Map<string, CdxFunction>();




/** Registers (or replaces) an expression function. Names are case-insensitive. */
export function registerCdxFunction(name: string, fn: CdxFunction): void {
    functions.set(name.toLowerCase(), fn);
}




//-------------------- Tokenizer --------------------
type TokenType = 'number' | 'string' | 'date' | 'logical' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'eof';

interface Token {
    type: TokenType;
    value: string;
    date?: Date;
}




function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    const n = source.length;

    const isDigit = (c: string) => c >= '0' && c <= '9';
    const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
    const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);

    while (i < n) {
        const c = source[i];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { ++i; continue; }

        if (c === '(') { tokens.push({type: 'lparen', value: c}); ++i; continue; }
        if (c === ')') { tokens.push({type: 'rparen', value: c}); ++i; continue; }
        if (c === ',') { tokens.push({type: 'comma', value: c}); ++i; continue; }

        if (c === '\'' || c === '"') {
            const quote = c;
            let j = i + 1;
            let text = '';
            while (j < n) {
                if (source[j] === quote) {
                    if (source[j + 1] === quote) { text += quote; j += 2; continue; }
                    break;
                }
                text += source[j++];
            }
            tokens.push({type: 'string', value: text});
            i = j + 1;
            continue;
        }

        if (c === '{') {
            const end = source.indexOf('}', i);
            if (end === -1) throw new Error(`Unterminated date literal in expression: ${source}`);
            const inner = source.slice(i + 1, end).replace(/^\^/, '').trim();
            tokens.push({type: 'date', value: inner, date: inner ? new Date(inner.replace(' ', 'T') + 'Z') : new Date(NaN)});
            i = end + 1;
            continue;
        }

        if (isDigit(c) || (c === '.' && isDigit(source[i + 1]))) {
            let j = i;
            while (j < n && (isDigit(source[j]) || source[j] === '.')) ++j;
            tokens.push({type: 'number', value: source.slice(i, j)});
            i = j;
            continue;
        }

        // Dotted keywords/logicals: .AND. .OR. .NOT. .T. .F.
        if (c === '.') {
            const end = source.indexOf('.', i + 1);
            if (end !== -1) {
                const word = source.slice(i + 1, end).toUpperCase();
                if (word === 'T' || word === 'F') {
                    tokens.push({type: 'logical', value: word});
                    i = end + 1;
                    continue;
                }
                if (word === 'AND' || word === 'OR' || word === 'NOT') {
                    tokens.push({type: 'op', value: word});
                    i = end + 1;
                    continue;
                }
            }
            throw new Error(`Unexpected '.' in expression: ${source}`);
        }

        if (isIdentStart(c)) {
            let j = i;
            while (j < n && isIdentPart(source[j])) ++j;
            const word = source.slice(i, j);
            const upper = word.toUpperCase();
            if (upper === 'AND' || upper === 'OR' || upper === 'NOT') tokens.push({type: 'op', value: upper});
            else tokens.push({type: 'ident', value: word});
            i = j;
            continue;
        }

        const two = source.slice(i, i + 2);
        if (two === '==' || two === '<>' || two === '!=' || two === '<=' || two === '>=') {
            tokens.push({type: 'op', value: two});
            i += 2;
            continue;
        }
        if ('+-*/%^=<>$'.includes(c)) {
            tokens.push({type: 'op', value: c});
            ++i;
            continue;
        }

        throw new Error(`Unexpected character '${c}' in expression: ${source}`);
    }

    tokens.push({type: 'eof', value: ''});
    return tokens;
}




//-------------------- Parser --------------------
type Node =
    | {kind: 'literal', value: CdxValue}
    | {kind: 'field', name: string}
    | {kind: 'call', name: string, args: Node[]}
    | {kind: 'unary', op: string, operand: Node}
    | {kind: 'binary', op: string, left: Node, right: Node};




/** A parsed and reusable CDX expression. */
export class CdxExpression {
    private constructor(readonly source: string, private readonly ast: Node, private readonly compat: ExpressionCompat) {}

    /** Parses an expression string, throwing a descriptive error on invalid syntax. */
    static parse(source: string, options?: CdxExpressionOptions): CdxExpression {
        const parser = new Parser(tokenize(source), source);
        const ast = parser.parse();
        return new CdxExpression(source, ast, options?.compat ?? 'standard');
    }

    /** Evaluates the expression against a record context. */
    evaluate(context: CdxEvalContext): CdxValue {
        return evaluateNode(this.ast, context, this.compat);
    }

    /** Field names referenced by the expression (for key-type inference). */
    get referencedFields(): string[] {
        const found = new Set<string>();
        collectFields(this.ast, found);
        return [...found];
    }

    /**
     * Infers the CDX key type from the expression's static result type. `fieldType` resolves a field
     * name to its key type; when a field is unknown the expression is assumed to be a character key.
     */
    inferKeyType(fieldType: (name: string) => CdxKeyType | undefined): CdxKeyType {
        return inferNodeType(this.ast, fieldType);
    }
}




class Parser {
    private pos = 0;
    constructor(private tokens: Token[], private source: string) {}

    parse(): Node {
        const node = this.parseOr();
        if (this.peek().type !== 'eof') throw new Error(`Unexpected token '${this.peek().value}' in expression: ${this.source}`);
        return node;
    }

    private peek(): Token { return this.tokens[this.pos]; }
    private next(): Token { return this.tokens[this.pos++]; }
    private matchOp(...ops: string[]): string | undefined {
        const token = this.peek();
        if (token.type === 'op' && ops.includes(token.value)) { ++this.pos; return token.value; }
        return undefined;
    }

    private parseOr(): Node {
        let left = this.parseAnd();
        while (this.matchOp('OR')) left = {kind: 'binary', op: 'OR', left, right: this.parseAnd()};
        return left;
    }

    private parseAnd(): Node {
        let left = this.parseNot();
        while (this.matchOp('AND')) left = {kind: 'binary', op: 'AND', left, right: this.parseNot()};
        return left;
    }

    private parseNot(): Node {
        if (this.matchOp('NOT')) return {kind: 'unary', op: 'NOT', operand: this.parseNot()};
        return this.parseComparison();
    }

    private parseComparison(): Node {
        let left = this.parseAdditive();
        for (;;) {
            const op = this.matchOp('=', '==', '<>', '!=', '<', '>', '<=', '>=', '$');
            if (!op) return left;
            left = {kind: 'binary', op, left, right: this.parseAdditive()};
        }
    }

    private parseAdditive(): Node {
        let left = this.parseMultiplicative();
        for (;;) {
            const op = this.matchOp('+', '-');
            if (!op) return left;
            left = {kind: 'binary', op, left, right: this.parseMultiplicative()};
        }
    }

    private parseMultiplicative(): Node {
        let left = this.parsePower();
        for (;;) {
            const op = this.matchOp('*', '/', '%');
            if (!op) return left;
            left = {kind: 'binary', op, left, right: this.parsePower()};
        }
    }

    private parsePower(): Node {
        const left = this.parseUnary();
        if (this.matchOp('^')) return {kind: 'binary', op: '^', left, right: this.parsePower()};
        return left;
    }

    private parseUnary(): Node {
        const op = this.matchOp('-', '+');
        if (op) return {kind: 'unary', op, operand: this.parseUnary()};
        return this.parsePrimary();
    }

    private parsePrimary(): Node {
        const token = this.next();
        switch (token.type) {
            case 'number': return {kind: 'literal', value: parseFloat(token.value)};
            case 'string': return {kind: 'literal', value: token.value};
            case 'date': return {kind: 'literal', value: token.date!};
            case 'logical': return {kind: 'literal', value: token.value === 'T'};
            case 'lparen': {
                const node = this.parseOr();
                if (this.next().type !== 'rparen') throw new Error(`Expected ')' in expression: ${this.source}`);
                return node;
            }
            case 'ident': {
                if (this.peek().type === 'lparen') {
                    ++this.pos;
                    const args: Node[] = [];
                    if (this.peek().type !== 'rparen') {
                        args.push(this.parseOr());
                        while (this.peek().type === 'comma') { ++this.pos; args.push(this.parseOr()); }
                    }
                    if (this.next().type !== 'rparen') throw new Error(`Expected ')' after function arguments in expression: ${this.source}`);
                    return {kind: 'call', name: token.value, args};
                }
                return {kind: 'field', name: token.value};
            }
            default:
                throw new Error(`Unexpected token '${token.value}' in expression: ${this.source}`);
        }
    }
}




function collectFields(node: Node, found: Set<string>): void {
    switch (node.kind) {
        case 'field': found.add(node.name); break;
        case 'call': for (const arg of node.args) collectFields(arg, found); break;
        case 'unary': collectFields(node.operand, found); break;
        case 'binary': collectFields(node.left, found); collectFields(node.right, found); break;
    }
}




// Infers the static result type of an expression node, used to pick a tag's key type on open.
function inferNodeType(node: Node, fieldType: (name: string) => CdxKeyType | undefined): CdxKeyType {
    switch (node.kind) {
        case 'literal':
            if (typeof node.value === 'number') return 'N';
            if (typeof node.value === 'boolean') return 'L';
            if (node.value instanceof Date) return 'D';
            return 'C';
        case 'field':
            return fieldType(node.name) ?? 'C';
        case 'unary':
            return node.op === 'NOT' ? 'L' : 'N';
        case 'binary': {
            const op = node.op;
            if (op === '=' || op === '==' || op === '<>' || op === '!=' || op === '<' || op === '>' || op === '<=' || op === '>=' || op === '$' || op === 'AND' || op === 'OR') return 'L';
            if (op === '+') {
                const left = inferNodeType(node.left, fieldType);
                const right = inferNodeType(node.right, fieldType);
                if (left === 'C' || right === 'C') return 'C';
                if (left === 'D' || left === 'T') return 'D';
                return 'N';
            }
            return 'N';
        }
        case 'call': {
            const name = node.name.toLowerCase();
            if (name === 'val' || name === 'year' || name === 'month' || name === 'day' || name === 'len' || name === 'at' || name === 'recno') return 'N';
            if (name === 'ctod' || name === 'date' || name === 'stod') return 'D';
            if (name === 'datetime' || name === 'ttoc') return 'T';
            if (name === 'deleted' || name === 'empty' || name === 'isnull') return 'L';
            if (name === 'iif') return node.args.length > 1 ? inferNodeType(node.args[1], fieldType) : 'C';
            return 'C';
        }
    }
}




//-------------------- Evaluator --------------------
function evaluateNode(node: Node, context: CdxEvalContext, compat: ExpressionCompat): CdxValue {
    switch (node.kind) {
        case 'literal': return node.value;
        case 'field': return context.getField(node.name);
        case 'call': {
            // In CodeBase compatibility mode, RIGHT() is evaluated as LEFT() (see CdxExpressionOptions).
            const name = compat === 'codebase' && node.name.toLowerCase() === 'right' ? 'left' : node.name.toLowerCase();
            const fn = functions.get(name);
            if (!fn) throw new Error(`Unsupported expression function '${node.name}()'`);
            return fn(node.args.map(arg => evaluateNode(arg, context, compat)), context);
        }
        case 'unary': {
            const value = evaluateNode(node.operand, context, compat);
            if (node.op === 'NOT') return !truthy(value);
            const num = toNumber(value);
            return node.op === '-' ? -num : num;
        }
        case 'binary': return evaluateBinary(node.op, node.left, node.right, context, compat);
    }
}




function evaluateBinary(op: string, leftNode: Node, rightNode: Node, context: CdxEvalContext, compat: ExpressionCompat): CdxValue {
    if (op === 'AND') return truthy(evaluateNode(leftNode, context, compat)) ? truthy(evaluateNode(rightNode, context, compat)) : false;
    if (op === 'OR') return truthy(evaluateNode(leftNode, context, compat)) ? true : truthy(evaluateNode(rightNode, context, compat));

    const left = evaluateNode(leftNode, context, compat);
    const right = evaluateNode(rightNode, context, compat);

    switch (op) {
        case '+': {
            if (typeof left === 'string' || typeof right === 'string') return toText(left) + toText(right);
            if (left instanceof Date && typeof right === 'number') return new Date(left.getTime() + right * 86_400_000);
            return toNumber(left) + toNumber(right);
        }
        case '-':
            if (left instanceof Date && typeof right === 'number') return new Date(left.getTime() - right * 86_400_000);
            return toNumber(left) - toNumber(right);
        case '*': return toNumber(left) * toNumber(right);
        case '/': return toNumber(left) / toNumber(right);
        case '%': return toNumber(left) % toNumber(right);
        case '^': return Math.pow(toNumber(left), toNumber(right));
        case '$': return toText(right).includes(toText(left));
        case '=':
        case '==': return compareValues(left, right) === 0;
        case '<>':
        case '!=': return compareValues(left, right) !== 0;
        case '<': return compareValues(left, right) < 0;
        case '>': return compareValues(left, right) > 0;
        case '<=': return compareValues(left, right) <= 0;
        case '>=': return compareValues(left, right) >= 0;
        default: throw new Error(`Unsupported operator '${op}'`);
    }
}




function truthy(value: CdxValue): boolean {
    if (value === null) return false;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (value instanceof Date) return !isNaN(value.getTime());
    return value.length > 0;
}




function toNumber(value: CdxValue): number {
    if (value === null) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.getTime();
    const num = parseFloat(value);
    return isNaN(num) ? 0 : num;
}




function toText(value: CdxValue): string {
    if (value === null) return '';
    if (value instanceof Date) return isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10).replace(/-/g, '');
    return String(value);
}




function compareValues(a: CdxValue, b: CdxValue): number {
    if (a instanceof Date || b instanceof Date) {
        const ta = a instanceof Date ? a.getTime() : NaN;
        const tb = b instanceof Date ? b.getTime() : NaN;
        if (!isNaN(ta) && !isNaN(tb)) return ta - tb;
    }
    if (typeof a === 'number' || typeof b === 'number') {
        const na = toNumber(a), nb = toNumber(b);
        return na - nb;
    }
    const sa = toText(a), sb = toText(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}




//-------------------- Built-in functions --------------------
function pad(text: string, length: number, padChar: string, right: boolean): string {
    const target = Math.max(0, Math.floor(length));
    if (text.length >= target) return text.slice(0, target);
    const fill = (padChar || ' ').repeat(target - text.length);
    return right ? text + fill : fill + text;
}




registerCdxFunction('UPPER', args => toText(args[0]).toUpperCase());
registerCdxFunction('LOWER', args => toText(args[0]).toLowerCase());
registerCdxFunction('PROPER', args => toText(args[0]).replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()));
registerCdxFunction('TRIM', args => toText(args[0]).replace(/\s+$/, ''));
registerCdxFunction('LTRIM', args => toText(args[0]).replace(/^\s+/, ''));
registerCdxFunction('RTRIM', args => toText(args[0]).replace(/\s+$/, ''));
registerCdxFunction('ALLTRIM', args => toText(args[0]).trim());
registerCdxFunction('LEFT', args => toText(args[0]).slice(0, Math.max(0, Math.floor(toNumber(args[1])))));
registerCdxFunction('RIGHT', args => {
    const length = Math.max(0, Math.floor(toNumber(args[1])));
    return toText(args[0]).slice(-length || undefined);
});
registerCdxFunction('SUBSTR', args => {
    const text = toText(args[0]);
    const start = Math.max(1, Math.floor(toNumber(args[1])));
    const length = args.length > 2 ? Math.max(0, Math.floor(toNumber(args[2]))) : text.length;
    return text.substr(start - 1, length);
});
registerCdxFunction('AT', args => toText(args[1]).indexOf(toText(args[0])) + 1);
registerCdxFunction('LEN', args => toText(args[0]).length);
registerCdxFunction('STR', args => {
    const value = toNumber(args[0]);
    const length = args.length > 1 ? Math.floor(toNumber(args[1])) : 10;
    const decimals = args.length > 2 ? Math.floor(toNumber(args[2])) : 0;
    const text = value.toFixed(decimals);
    return text.length >= length ? text : ' '.repeat(length - text.length) + text;
});
registerCdxFunction('VAL', args => {
    const num = parseFloat(toText(args[0]));
    return isNaN(num) ? 0 : num;
});
registerCdxFunction('DTOS', args => toText(args[0]));
registerCdxFunction('CTOD', args => new Date(toText(args[0])));
registerCdxFunction('DTOC', args => toText(args[0]));
registerCdxFunction('DATE', () => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
});
registerCdxFunction('YEAR', args => (args[0] instanceof Date ? args[0].getUTCFullYear() : 0));
registerCdxFunction('MONTH', args => (args[0] instanceof Date ? args[0].getUTCMonth() + 1 : 0));
registerCdxFunction('DAY', args => (args[0] instanceof Date ? args[0].getUTCDate() : 0));
registerCdxFunction('IIF', (args, _context) => truthy(args[0]) ? args[1] : args[2]);
registerCdxFunction('EMPTY', args => {
    const value = args[0];
    if (value === null) return true;
    if (typeof value === 'string') return value.trim().length === 0;
    if (typeof value === 'number') return value === 0;
    if (typeof value === 'boolean') return !value;
    if (value instanceof Date) return isNaN(value.getTime());
    return false;
});
registerCdxFunction('ISNULL', args => args[0] === null);
registerCdxFunction('PADL', args => pad(toText(args[0]), toNumber(args[1]), toText(args[2]), false));
registerCdxFunction('PADR', args => pad(toText(args[0]), toNumber(args[1]), toText(args[2]), true));
registerCdxFunction('DELETED', (_args, context) => context.isDeleted());
