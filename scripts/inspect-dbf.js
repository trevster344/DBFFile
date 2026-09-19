#!/usr/bin/env node
'use strict';

// Ad-hoc inspector for a DBF file you drop into ./local (or anywhere).
//
//   node scripts/inspect-dbf.js local/mytable.dbf
//
// It prints the header/field layout, reads a few records, and — if a production .cdx index sits
// next to the .dbf — opens it, lists the tags, reads records in tag order, checks the index
// integrity and tries a seek. Requires `npm run build` first (it uses ./dist).

const fs = require('fs');
const path = require('path');

const {DBFFile, collationForName} = require('../dist/index.js');

// VFP language driver byte -> encoding (a small, common subset; override with --encoding).
const LANGUAGE_DRIVER_ENCODING = {
    0x01: 'cp437',
    0x02: 'cp850',
    0x03: 'cp1252',
    0x64: 'cp852',
    0x65: 'cp865',
    0x66: 'cp866',
    0xc8: 'cp1250',
};

function usage() {
    console.log(`Usage: node scripts/inspect-dbf.js <file.dbf> [options]

Options:
  --encoding <name>   Override the character encoding (e.g. cp850, cp1252, big5)
  --loose             Open in loose read mode (tolerate unsupported versions/field types)
  --no-cdx            Ignore any .cdx index next to the file
  --compat <mode>     Expression compatibility: standard (default) or codebase (Sequiter)
  --records <n>       Number of records to print (default 10)
  --all               Print all records`);
}

function parseArgs(argv) {
    const opts = {encoding: undefined, loose: false, cdx: true, compat: 'standard', records: 10, all: false, file: undefined};
    for (let i = 2; i < argv.length; ++i) {
        const a = argv[i];
        if (a === '--encoding') opts.encoding = argv[++i];
        else if (a === '--loose') opts.loose = true;
        else if (a === '--no-cdx') opts.cdx = false;
        else if (a === '--compat') opts.compat = argv[++i];
        else if (a === '--records') opts.records = parseInt(argv[++i], 10) || 10;
        else if (a === '--all') opts.all = true;
        else if (a === '--help' || a === '-h') opts.help = true;
        else if (!opts.file) opts.file = a;
        else { console.error(`Unknown option: ${a}`); opts.help = true; }
    }
    return opts;
}

function findSibling(dbfPath, exts) {
    const base = dbfPath.slice(0, -path.extname(dbfPath).length);
    for (const ext of exts) {
        if (fs.existsSync(base + ext)) return base + ext;
    }
    return undefined;
}

function languageDriverEncoding(dbfPath) {
    try {
        const fd = fs.openSync(dbfPath, 'r');
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, 29);
        fs.closeSync(fd);
        return LANGUAGE_DRIVER_ENCODING[b[0]];
    }
    catch {
        return undefined;
    }
}

function validateIndexIntegrity(dbf, tag) {
    const cdx = dbf._cdx;
    const leaves = cdx.leaves(tag.name);
    const problems = [];
    if (leaves.length) {
        if (leaves[0].left !== -1) problems.push('first leaf left link is not -1');
        if (leaves[leaves.length - 1].right !== -1) problems.push('last leaf right link is not -1');
        for (let i = 0; i < leaves.length - 1; ++i) {
            if (leaves[i].right !== leaves[i + 1].page) problems.push(`leaf ${i} right link is not the next leaf`);
            if (leaves[i + 1].left !== leaves[i].page) problems.push(`leaf ${i + 1} left link is not the previous leaf`);
        }
    }
    const entries = [...cdx.iterateTag(tag.name)];
    const counted = leaves.reduce((sum, leaf) => sum + leaf.count, 0);
    if (entries.length !== counted) problems.push(`entry count ${entries.length} != leaf counts ${counted}`);

    const pad = tag.keyType === 'C' ? 0x20 : 0x00;
    const logical = key => { let end = key.length; while (end > 0 && key[end - 1] === pad) --end; return key.subarray(0, end); };
    const seen = new Set();
    let previous;
    for (const entry of entries) {
        if (entry.recno < 1 || entry.recno > dbf.recordCount) problems.push(`recno ${entry.recno} out of range`);
        if (seen.has(entry.recno)) problems.push(`duplicate recno ${entry.recno}`);
        seen.add(entry.recno);
        if (previous && Buffer.compare(previous, logical(entry.key)) > 0) problems.push(`keys out of order at recno ${entry.recno}`);
        previous = logical(entry.key);
    }
    const fullCoverage = !tag.filtered && !tag.unique;
    return {leafCount: leaves.length, entryCount: entries.length, coverage: seen.size, fullCoverage, problems};
}

async function main() {
    const opts = parseArgs(process.argv);
    if (opts.help || !opts.file) { usage(); process.exit(opts.help ? 0 : 1); }

    const dbfPath = path.resolve(opts.file);
    if (!fs.existsSync(dbfPath)) { console.error(`File not found: ${dbfPath}`); process.exit(1); }

    const encoding = opts.encoding || languageDriverEncoding(dbfPath) || 'ISO-8859-1';
    const memoPath = findSibling(dbfPath, ['.dbt', '.DBT', '.fpt', '.FPT']);
    const cdxPath = opts.cdx ? findSibling(dbfPath, ['.cdx', '.CDX']) : undefined;

    console.log(`File:      ${dbfPath}`);
    console.log(`Encoding:  ${encoding}`);
    console.log(`Memo file: ${memoPath || '(none)'}`);
    console.log(`CDX file:  ${cdxPath || '(none)'}`);
    console.log('');

    // First pass without the index, to read the version/fields/records.
    const openOptions = {encoding, readMode: opts.loose ? 'loose' : 'strict', expressionCompat: opts.compat};
    const base = await DBFFile.open(dbfPath, openOptions);
    console.log(`Version:       0x${(base._version || 0).toString(16)}`);
    console.log(`Record count:  ${base.recordCount}`);
    console.log(`Header length: ${base._headerLength}`);
    console.log(`Record length: ${base._recordLength}`);
    console.log(`Fields (${base.fields.length}):`);
    for (const f of base.fields) {
        console.log(`  ${f.name.padEnd(11)} ${f.type}  size=${String(f.size).padStart(3)}  dec=${f.decimalPlaces ?? 0}`);
    }
    console.log('');

    const limit = opts.all ? 10000000 : opts.records;
    const records = await base.readRecords(limit);
    console.log(`First ${records.length} record(s):`);
    for (let i = 0; i < records.length; ++i) console.log(`  [${i}] ${JSON.stringify(records[i])}`);

    // Now with the index, if present.
    if (!cdxPath) return;
    const version = base._version;
    const cdxVersion = version === 0x30 || version === 0x31 ? 0x30 : 0xf5;
    console.log('');
    console.log(`=== CDX index (compatibility 0x${cdxVersion.toString(16)}) ===`);

    const indexed = await DBFFile.open(dbfPath, {...openOptions, cdx: cdxVersion});
    console.log(`Tags (${indexed.tags.length}):`);
    for (const tag of indexed.tags) {
        console.log(`  ${tag.name.padEnd(11)} key=${JSON.stringify(tag.keyExpression).padEnd(40)} type=${tag.keyType} len=${tag.keyLength} collation=${tag.collation || 'MACHINE'}${tag.filtered ? ' FOR=' + JSON.stringify(tag.forExpression) : ''}${tag.descending ? ' DESC' : ''}${tag.unique ? ' UNIQUE' : ''}`);
    }

    for (const tag of indexed.tags) {
        const result = validateIndexIntegrity(indexed, tag);
        console.log('');
        console.log(`Tag '${tag.name}': ${result.entryCount} entries across ${result.leafCount} leaf page(s), coverage ${result.coverage}/${indexed.recordCount}`);
        console.log(`  integrity: ${result.problems.length ? 'FAIL - ' + result.problems.join('; ') : 'OK'}`);

        const ordered = await indexed.readRecords({index: tag.name, maxCount: limit});
        console.log(`  readRecords({index}) -> ${ordered.length} record(s); first=${JSON.stringify(ordered[0] || null)}`);

        // Try a seek using the first entry's key value from the expression, when it's a simple field.
        const simple = indexed.fields.find(f => f.name.toLowerCase() === tag.keyExpression.trim().toLowerCase());
        if (simple && records[0] && records[0][simple.name] !== undefined && records[0][simple.name] !== null) {
            const value = records[0][simple.name];
            const found = await indexed.seek(tag.name, value);
            console.log(`  seek(${JSON.stringify(value)}) -> ${found ? 'found' : 'NOT FOUND'}`);
        }
    }
}

main().catch(err => {
    console.error('');
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
});
