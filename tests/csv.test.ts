import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeCsvCell, parseCsv, toCsv } from '../src/lib/csv';

test('escapeCsvCell neutralizes spreadsheet formula injection and quotes commas', () => {
  assert.equal(escapeCsvCell('=CMD("calc")'), '"\'=CMD(""calc"")"');
  assert.equal(escapeCsvCell('+SUM(A1:A2)'), '\'+SUM(A1:A2)');
  assert.equal(escapeCsvCell('hello, world'), '"hello, world"');
  assert.equal(escapeCsvCell('a"b'), '"a""b"');
});

test('toCsv and parseCsv round-trip structured records accurately', () => {
  const csv = toCsv(
    ['email', 'displayName', 'role'],
    [
      { email: 'alice@corp.io', displayName: 'Alice, Lead', role: 'admin' },
      { email: 'bob@corp.io', displayName: 'Bob "Ops"', role: 'manager' },
    ]
  );

  const parsed = parseCsv(csv);
  assert.deepEqual(parsed.headers, ['email', 'displayName', 'role']);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].displayName, 'Alice, Lead');
  assert.equal(parsed.rows[1].displayName, 'Bob "Ops"');
});
