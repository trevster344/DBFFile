# CDX compound index support

DBFFile can read and write FoxPro/Visual FoxPro **CDX** compound indexes, including the **production
index** (a `.cdx` whose base name matches the `.dbf`). This document describes the API, the format
model, and the maintenance behaviour.

## Opting in

CDX usage is opt-in. Pass the raw index version as the `cdx` option:

```javascript
import {DBFFile} from 'dbffile';

// Open the production <name>.cdx and assume VFP9 compatibility.
const dbf = await DBFFile.open('customers.dbf', {cdx: 0x30});
console.log(dbf.tags.map(t => `${t.name}: ${t.keyExpression}`));

// Or give an explicit path:
const other = await DBFFile.open('customers.dbf', {cdx: {version: 0x30, path: 'customers.cdx'}});
```

- `0x30` — Visual FoxPro 9 (requires a `0x30`/`0x31` table; also accepts `0x31`, VFP with autoincrement).
- `0xf5` — FoxPro 2.x (requires a `0xf5` table, or a `0x03` table without a memo field — `0x03` is
  shared with dBase III+, so the `.cdx` itself is what marks it as FoxPro 2.x).

Omitting `cdx` ignores any `.cdx` present. When set, the production `.cdx` (or the explicit path) is
opened and verified: a missing file, a version mismatch with the DBF, or a non-compound file throws.

## Reading

```javascript
// Tag metadata.
for (const tag of dbf.tags) console.log(tag.name, tag.keyExpression, tag.keyType, tag.descending);

// Read records in tag order (ascending, or descending for a descending tag).
const ordered = await dbf.readRecords({index: 'NAME'});

// Exact key lookup.
const record = await dbf.seek('NAME', 'SMITH');
```

`readRecords({index, maxCount})` returns records ordered by the tag. `seek(tag, value)` encodes the
value for the tag's key type and descends the B-tree, returning the first matching record or
`undefined`.

## Creating and reindexing

```javascript
const dbf = await DBFFile.create('customers.dbf', fields, {
    fileVersion: 0x30,
    indexes: [
        {tag: 'NAME',  expression: 'NAME'},
        {tag: 'UPPER', expression: 'UPPER(NAME)'},
        {tag: 'CUST',  expression: 'UPPER(CLASS)+STR(ID)', for: '.NOT. DELETED()'},
        {tag: 'UNIQ',  expression: 'EMAIL', unique: true},
        {tag: 'DESC',  expression: 'CREATED', descending: true},
    ],
});

await dbf.appendRecords(records);
await dbf.reindex(); // rebuild the production .cdx from the current records
```

`reindex(tag?)` rebuilds the whole index, or a single tag, from the DBF's records. Index maintenance
is **lazy**: writes mark the index dirty and it is rebuilt on `close()`, or before the next index
read/`seek`. This avoids incremental B-tree churn during writes; `reindex()` is always available as a
repair path.

## Delete / undelete

```javascript
await dbf.deleteRecord(3);   // set the 0x2A flag
await dbf.undeleteRecord(3); // clear it
```

Deleted records are excluded from the index (and from index-ordered reads unless
`includeDeletedRecords` is set), while still counting toward `recordCount`.

## Expression support

Key and FOR expressions use a small xBase expression evaluator (`src/cdx/cdx-expression.ts`)
supporting field references, string/numeric/date/logical literals, `+ - * / % ^`, comparisons
(`= == <> != < > <= >=`), `$`, `.AND.`/`.OR.`/`.NOT.`, and the functions `UPPER LOWER PROPER TRIM
LTRIM RTRIM ALLTRIM LEFT RIGHT SUBSTR AT STR VAL DTOS CTOD DTOC DATE YEAR MONTH DAY IIF EMPTY LEN
PADL PADR DELETED`. Additional functions can be registered:

```javascript
import {registerCdxFunction} from 'dbffile';
registerCdxFunction('MYFUNC', args => /* ... */);
```

Unsupported functions raise a descriptive error rather than producing an incorrect key.

## Locking

The index file participates in the optional locking model. `lockIndexFile()` / `unlockIndexFile()`
lock the `.cdx` header region, and `reindex()` takes the index lock while rewriting the file when
`{locking: true}` is set.

## Format notes

A CDX is a compound index: a tag-directory B-tree maps 10-byte tag names to tag-header pages, and
each tag header points at a compressed per-tag B-tree. Pages are 512 bytes; tag headers are 1024
bytes with the key/FOR expressions at offset 512. Leaf keys are compressed with duplicate-prefix and
trailing-byte elimination, and each entry packs the record number, duplicate count and trailing count
into a small bit field. The implementation targets the FoxPro/VFP layout and is validated against
real VFP `.cdx` fixtures under `test/fixtures/cdx/`.

## Collation

Tags record a VFP sort sequence. `MACHINE` (the default) stores the raw code-page bytes; `GENERAL`
stores a collation *weight* key (2 bytes per character, so a key expression is limited to 120
characters). `GENERAL` weights are code-page specific; DBFFile supports CP1252, CP437 and CP850
(selected from the table's language driver / the `encoding` option) using weight tables ported from
the CodeBase reference `COLL4ARR.C`. Additional sequences can be supplied with
`registerCdxCollation()`.

Keys are compared the way FoxPro compares them: trailing pad bytes are insignificant and a key that
is a prefix of another sorts first. Key expressions are evaluated over the **untrimmed, fixed-width**
field values, so concatenation expressions match FoxPro.

## Multi-client concurrency

When `{locking: true}` is set, concurrent clients coordinate as follows:

- **Reads** take a **shared** DBF file lock for the duration, so they are refused only when a writer
  holds the **exclusive** lock (record locks never block reads).
- **Appends** require the **exclusive** DBF file lock (`lockFile()`).
- **Record updates** take the record lock and are refused only when a foreign **exclusive** file lock
  is held (a concurrent reader/reindex shared lock does not block them).
- **Reindex** holds the **exclusive index lock across the whole read-rebuild-write**, so a reindex
  with an older DBF snapshot cannot write last and clobber a newer index. It reads the DBF under a
  **shared** DBF lock (waiting for an in-progress writer) and refreshes the header inside the lock.
- The rebuilt index is written **atomically** (temp file + rename) where the platform allows it,
  falling back to an in-place write under the exclusive index lock on Windows (which refuses to
  rename over a file that another handle has open). Lock-aware readers never observe a partial index.

The tests in `test/cdx-concurrency.ts` exercise these with forked worker processes: concurrent
appends, concurrent reindexing, concurrent distinct-record updates, a reader racing a writer, a
process killed mid-reindex, and mixed appends + reads.

## Sequiter CodeBase compatibility

Indexes written by **Sequiter CodeBase** (an xBase library common in the 1990s/2000s) evaluate some
functions differently from FoxPro. In particular CodeBase aliases `RIGHT()` to the same routine as
`LEFT()`/`SUBSTR()`, so for a variable-length or subexpression argument it returns the **leftmost**
`n` characters rather than the rightmost. An index built by CodeBase may therefore contain keys that
do not match a standard FoxPro evaluation of the tag's own expression.

Reading such an index works as-is (the reader follows the stored keys). To **reindex** it — or to
build new tags with CodeBase semantics — pass the opt-in compatibility mode:

```javascript
const dbf = await DBFFile.open('attend.dbf', {cdx: 0xf5, expressionCompat: 'codebase'});
await dbf.reindex();   // RIGHT(...) is evaluated as LEFT(...), reproducing CodeBase's keys
```

`expressionCompat` is `'standard'` (the default) or `'codebase'`. It affects key/`FOR` expression
evaluation only; it does not change collation or the on-disk format.

As a safety net, reindexing refuses to overwrite a tag when the rebuilt keys match **none** of the
stored keys *and* rebuilding under the other compatibility mode **would** reproduce them (which
identifies the index as belonging to the other mode). This prevents silently clobbering a CodeBase
index. The check is bypassed with `dbf.reindex(tag?, {force: true})`.

## Testing

`test/cdx-integrity.ts` validates the reader and writer against the real fixtures:

- **integrity** — leaf-link consistency, key ordering (logical comparison), record-number bounds and
  uniqueness, and full record coverage for unfiltered tags;
- **key correctness** — every stored key equals the key computed from the record's padded field
  values using the tag's collation (0 mismatches across all fixtures);
- **round-trip** — reindexing a fixture reproduces the original index's exact key and record order;
- **writer stress** — a generated index that spans multiple leaf and interior pages; and a truncated
  index throws rather than returning wrong data.

`test/cdx-stress.ts` runs a large-scale concurrency stress test (see [TESTING.md](./TESTING.md)):
several client processes concurrently append batches, delete records and edit records in the middle
of a table of hundreds of thousands of rows, after which the index must be a complete, correct
reflection of the final DBF.

## Known limitations

- Reindex is a full rebuild; incremental B-tree maintenance is not implemented.
- The coordination above is gated on `{locking: true}`. Without it, concurrent writers can race (and
  a non-locking reader may observe a partial index write); use locking for multi-client access.
- External changes made **after** the index is opened are detected on the next index read/`seek` (the
  on-disk DBF header is compared against a fingerprint recorded when the index was last built, and a
  difference triggers a rebuild). Changes made **before** the index is opened are not detected, since
  there is no marker stored in the index file itself.
- `GENERAL` is supported for CP1252/CP437/CP850 only; other sort sequences fall back to `MACHINE`
  until their weight tables are registered.
- `.idx`/`.ndx`/`.mdx` single-file and dBase compound indexes are out of scope.
