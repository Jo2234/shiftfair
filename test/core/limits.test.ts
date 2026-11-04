import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSaveFile, serializePlan, LIMITS } from '../../src/core/io.ts';
import { validateAssignments } from '../../src/core/constraints.ts';
import type { EventPlan } from '../../src/core/types.ts';

// Largest valid plan the limits allow, with every string at maximum length and
// made of a character JSON escapes to six bytes. Built in memory only.
function worstCasePlan(): EventPlan {
    const longText = (length: number) => '\u0001'.repeat(length);
    const id = (prefix: string, index: number) => `${prefix}${index}_`.padEnd(40, 'x');
    const skills = Array.from({ length: LIMITS.skillsPerItem }, (_, index) =>
        `${String.fromCharCode(97 + index)}-`.padEnd(30, 'z'));
    // 20 availability windows of 71 minutes, separated by 1-minute gaps.
    const availability = Array.from({ length: LIMITS.availabilityWindows }, (_, index) => ({
        start: index * 72,
        end: index * 72 + 71,
    }));
    const volunteerCount = LIMITS.volunteers;
    const shiftCount = LIMITS.shifts;
    const needed = LIMITS.maxNeeded;
    const plan: EventPlan = {
        name: longText(LIMITS.nameLength),
        dateLabel: longText(LIMITS.dateLabelLength),
        roles: Array.from({ length: LIMITS.roles }, (_, index) => ({
            id: id('r', index),
            name: longText(LIMITS.nameLength),
            requiredSkills: skills,
        })),
        volunteers: Array.from({ length: volunteerCount }, (_, index) => ({
            id: id('v', index),
            name: longText(LIMITS.nameLength),
            skills,
            availability,
            maxShifts: LIMITS.maxShiftsCap,
            maxMinutes: 1440,
        })),
        // 300 distinct one-minute shifts, each inside one availability window.
        shifts: Array.from({ length: shiftCount }, (_, index) => {
            const start = (index % LIMITS.availabilityWindows) * 72 + Math.floor(index / LIMITS.availabilityWindows);
            return {
                id: id('s', index),
                roleId: id('r', index % LIMITS.roles),
                label: longText(LIMITS.labelLength),
                start,
                end: start + 1,
                needed,
            };
        }),
        assignments: [],
    };
    for (let shift = 0; shift < shiftCount; shift++) {
        for (let offset = 0; offset < needed; offset++) {
            plan.assignments.push({
                shiftId: id('s', shift),
                volunteerId: id('v', (shift + offset) % volunteerCount),
                locked: offset % 2 === 0,
            });
        }
    }
    return plan;
}

test('every count limit is reachable together and the largest valid plan round-trips', t => {
    const plan = worstCasePlan();
    assert.equal(plan.assignments.length, LIMITS.assignments);
    assert.equal(validateAssignments(plan).invalid.length, 0, 'fixture is a valid, fully staffed plan');
    const text = serializePlan(plan);
    const bytes = new TextEncoder().encode(text).length;
    t.diagnostic(`worst-case serialized bytes=${bytes} limit=${LIMITS.maxBytes}`);
    assert.ok(bytes <= LIMITS.maxBytes, `${bytes} bytes must fit in ${LIMITS.maxBytes}`);
    const started = performance.now();
    const parsed = parseSaveFile(text);
    t.diagnostic(`worst-case parse durationMs=${Math.round(performance.now() - started)}`);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.errors.join('\n'));
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.plan, plan);
    assert.deepEqual(parsed.warnings, []);
});

test('limits are still enforced just above the supported bounds', () => {
    const plan = worstCasePlan();
    const extraAssignment = { ...plan, assignments: [...plan.assignments, plan.assignments[0]!] };
    const tooMany = parseSaveFile(serializePlan(extraAssignment));
    assert.equal(tooMany.ok, false);
    const oversized = parseSaveFile(' '.repeat(LIMITS.maxBytes + 1));
    assert.equal(oversized.ok, false);
    assert.ok(!oversized.ok && /limit/.test(oversized.errors[0]!));
});
