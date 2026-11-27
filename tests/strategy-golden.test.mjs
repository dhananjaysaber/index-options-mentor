// Locks how the 13-Point and Scalp rules behave today. A failure means an
// entry, stop, protection, trail or sizing result changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allCases, NAMED, play } from './golden/cases.mjs';

const baseline = JSON.parse(readFileSync(new URL('./golden/baseline.json', import.meta.url), 'utf8'));
const current = await allCases();

for (const section of Object.keys(baseline)) {
  test(`strategy behaviour is unchanged: ${section}`, () => {
    // Compare case by case so a failure names the case that moved.
    const was = baseline[section], is = JSON.parse(JSON.stringify(current[section]));
    assert.deepEqual(Object.keys(is), Object.keys(was));
    for (const key of Object.keys(was)) assert.deepEqual(is[key], was[key], `${section} / ${key}`);
  });
}

test('no section is missing from the record', () => {
  assert.deepEqual(Object.keys(current), Object.keys(baseline));
});

test('each named scenario ends the way its name says, for CE and PE', async () => {
  for (const side of ['CE', 'PE'])
    for (const [name, [family, ticks, expected]] of Object.entries(NAMED)) {
      const steps = await play(family, side, ticks);
      assert.equal(steps.length, ticks.length, `${side} ${name}: ended early`);
      assert.equal(steps.at(-1).exit, expected, `${side} ${name}`);
    }
});
