import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeGap, describeStatus } from '../../src/core/explain.ts';
import type { Shift, UnfilledSlot, SolveResult } from '../../src/core/types.ts';

test('gap wording covers all branches and singular/plural', () => {
    const shift: Shift = { id: 's', roleId: 'r', label: '', start: 0, end: 60, needed: 3 };
    const slot: UnfilledSlot = {
        shiftId: 's', missing: 3, eligibleTotal: 0, reason: 'no-eligible-volunteer', blockers: []
    };
    const changes = 'Add volunteers or change skills, availability, limits or headcount.';
    assert.equal(describeGap(slot, shift),
        'Needs 3 more. No volunteer in this plan has the required skills, availability and limits for this shift. '
        + changes);
    assert.equal(describeGap({ ...slot, eligibleTotal: 1, missing: 2 }, shift),
        'Needs 2 more. Only 1 volunteer in this plan has the required skills, availability and limits for this shift,'
        + ` and that volunteer is already on it. ${changes}`);
    assert.equal(describeGap({ ...slot, eligibleTotal: 2, missing: 1 }, shift),
        'Needs 1 more. Only 2 volunteers in this plan have the required skills, availability and limits for this'
        + ` shift, and all of them are already on it. ${changes}`);

    const overlap = { kind: 'overlap', shiftId: 'x' } as const;
    const heuristic = ' Moving or unlocking other assignments may help; the search is heuristic, so this is not proof'
        + ' either way.';
    const blocked = (ids: string[]) => ids.map(volunteerId => ({ volunteerId, blockers: [overlap] }));
    const free = (ids: string[]) => ids.map(volunteerId => ({ volunteerId, blockers: [] }));
    assert.equal(describeGap({
        ...slot, reason: 'blocked-by-assignments', eligibleTotal: 3, missing: 2, blockers: blocked(['a', 'b'])
    }, shift),
        'Needs 2 more. 3 volunteers in this plan qualify: 1 already on this shift, 0 can be added now and 2 blocked'
        + ` by other assignments (overlap or limits).${heuristic}`);
    assert.equal(describeGap({
        ...slot, reason: 'blocked-by-assignments', eligibleTotal: 1, blockers: blocked(['a'])
    }, shift),
        'Needs 3 more. 1 volunteer in this plan qualifies: 0 already on this shift, 0 can be added now and 1 blocked'
        + ` by other assignments (overlap or limits).${heuristic}`
        + ' Even then, at most 1 more can be added, so at least 2 slots need plan changes.');
    // Before Generate (or after a tiny budget): eligible people with no blockers are not conflicts.
    assert.equal(describeGap({
        ...slot, reason: 'eligible-available', eligibleTotal: 2, blockers: free(['a', 'b'])
    }, shift),
        'Needs 3 more. 2 volunteers in this plan qualify: 0 already on this shift, 2 can be added now and 0 blocked'
        + ' by other assignments (overlap or limits). Generate the roster or add a volunteer manually.'
        + ' Even then, at most 2 more can be added, so at least 1 slot needs plan changes.');
    assert.equal(describeGap({
        ...slot, reason: 'eligible-available', eligibleTotal: 4, missing: 2,
        blockers: [...free(['a']), ...blocked(['b', 'c'])]
    }, shift),
        'Needs 2 more. 4 volunteers in this plan qualify: 1 already on this shift, 1 can be added now and 2 blocked'
        + ' by other assignments (overlap or limits). Generate the roster or add a volunteer manually.'
        + heuristic);
});

test('status wording is exact and model relative', () => {
    const result: SolveResult = {
        status: 'all-filled', assignments: [], unfilled: [], loads: [], stepsUsed: 123,
        filledSlots: 4, totalSlots: 4, droppedLocked: []
    };
    assert.equal(describeStatus(result),
        'All 4 slots filled; every hard constraint in this plan is satisfied. Fairness is a heuristic balance, not a guaranteed optimum.');
    assert.equal(describeStatus({ ...result, status: 'partial', filledSlots: 2 }),
        '2 of 4 slots filled. Gaps marked "not enough eligible volunteers" cannot be filled with the current plan data (skills, availability, limits); other gaps might be fillable by a different arrangement — the search is heuristic, not exhaustive.');
    assert.equal(describeStatus({ ...result, status: 'budget-exhausted', filledSlots: 2 }),
        'Search budget reached after 123 steps; 2 of 4 slots filled. The roster obeys every hard constraint but coverage and fairness may be improvable.');
});
