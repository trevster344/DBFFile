import {expect} from 'chai';
import {CdxEvalContext, CdxExpression, registerCdxFunction} from 'dbffile';




describe('CDX expression engine', () => {

    const fields: Record<string, unknown> = {
        NAME: 'Joe Bloggs',
        FIRST: 'joe',
        AMOUNT: 12.5,
        QTY: 3,
        BDATE: new Date('2020-01-02'),
        ACTIVE: true,
        DELETED: false,
    };

    const context: CdxEvalContext = {
        getField: name => {
            const value = fields[name.toUpperCase()];
            return value === undefined ? null : value as any;
        },
        isDeleted: () => fields.DELETED === true,
    };

    const evalExpr = (source: string) => CdxExpression.parse(source).evaluate(context);

    it('evaluates string functions', () => {
        expect(evalExpr('UPPER(first)')).equals('JOE');
        expect(evalExpr('LOWER("ABC")')).equals('abc');
        expect(evalExpr('LEFT(first,2)')).equals('jo');
        expect(evalExpr('RIGHT(first,2)')).equals('oe');
        expect(evalExpr('SUBSTR(first,2,2)')).equals('oe');
        expect(evalExpr('ALLTRIM("  x  ")')).equals('x');
        expect(evalExpr('LEN(first)')).equals(3);
        expect(evalExpr('AT("o",first)')).equals(2);
    });

    it('concatenates strings with +', () => {
        expect(evalExpr('UPPER(first)+"!"')).equals('JOE!');
    });

    it('evaluates numeric functions and arithmetic', () => {
        expect(evalExpr('AMOUNT * QTY')).equals(37.5);
        expect(evalExpr('VAL("42") + 1')).equals(43);
        expect(evalExpr('STR(AMOUNT,10,2)')).equals('     12.50');
        expect(evalExpr('2 + 3 * 4')).equals(14);
        expect(evalExpr('(2 + 3) * 4')).equals(20);
    });

    it('evaluates comparisons and logical operators', () => {
        expect(evalExpr('AMOUNT > 10')).equals(true);
        expect(evalExpr('AMOUNT > 10 .AND. ACTIVE')).equals(true);
        expect(evalExpr('AMOUNT > 100 .OR. ACTIVE')).equals(true);
        expect(evalExpr('.NOT. ACTIVE')).equals(false);
        expect(evalExpr('first == "joe"')).equals(true);
        expect(evalExpr('first <> "joe"')).equals(false);
        expect(evalExpr('"oe" $ first')).equals(true);
    });

    it('evaluates IIF and EMPTY', () => {
        expect(evalExpr('IIF(ACTIVE,"Y","N")')).equals('Y');
        expect(evalExpr('EMPTY("")')).equals(true);
        expect(evalExpr('EMPTY(first)')).equals(false);
    });

    it('evaluates date functions', () => {
        expect(evalExpr('YEAR(BDATE)')).equals(2020);
        expect(evalExpr('MONTH(BDATE)')).equals(1);
        expect(evalExpr('DAY(BDATE)')).equals(2);
    });

    it('evaluates DELETED() against the record state', () => {
        expect(evalExpr('DELETED()')).equals(false);
        expect(evalExpr('.NOT. DELETED()')).equals(true);
        fields.DELETED = true;
        expect(evalExpr('DELETED()')).equals(true);
        fields.DELETED = false;
    });

    it('parses date literals', () => {
        const value = evalExpr('YEAR({^2021-06-15})');
        expect(value).equals(2021);
    });

    it('reports referenced fields', () => {
        const expression = CdxExpression.parse('UPPER(first)+UPPER(name)');
        expect(expression.referencedFields.map(f => f.toLowerCase()).sort()).deep.equals(['first', 'name']);
    });

    it('evaluates RIGHT as LEFT in codebase compatibility mode', () => {
        const fields2: Record<string, unknown> = {CODE: 'abcdefgh'};
        const context2: CdxEvalContext = {
            getField: name => (fields2[name.toUpperCase()] ?? null) as any,
            isDeleted: () => false,
        };
        expect(CdxExpression.parse('RIGHT(CODE,4)').evaluate(context2)).equals('efgh');
        expect(CdxExpression.parse('RIGHT(CODE,4)', {compat: 'codebase'}).evaluate(context2)).equals('abcd');
        expect(CdxExpression.parse('LEFT(CODE,4)', {compat: 'codebase'}).evaluate(context2)).equals('abcd');
    });

    it('infers a tag key type from the expression result type', () => {
        const fieldType = (name: string) => ({AMOUNT: 'N', BDATE: 'D', ACTIVE: 'L'} as Record<string, 'C' | 'N' | 'D' | 'L'>)[name.toUpperCase()] ?? 'C';
        expect(CdxExpression.parse('VAL(first)').inferKeyType(fieldType)).equals('N');
        expect(CdxExpression.parse('AMOUNT').inferKeyType(fieldType)).equals('N');
        expect(CdxExpression.parse('UPPER(first)').inferKeyType(fieldType)).equals('C');
        expect(CdxExpression.parse('BDATE').inferKeyType(fieldType)).equals('D');
        expect(CdxExpression.parse('ACTIVE').inferKeyType(fieldType)).equals('L');
        expect(CdxExpression.parse('AMOUNT > 10').inferKeyType(fieldType)).equals('L');
    });

    it('throws on unsupported functions', () => {
        expect(() => evalExpr('NOSUCHFUNC(1)')).to.throw(/Unsupported expression function/);
    });

    it('supports registering custom functions', () => {
        registerCdxFunction('DOUBLEIT', args => Number(args[0]) * 2);
        expect(evalExpr('DOUBLEIT(QTY)')).equals(6);
    });
});
