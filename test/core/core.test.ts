import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTime, formatTime, overlaps, parseAvailability } from "../../src/core/time.ts";
import { normalizeSkills } from "../../src/core/skills.ts";
import { checkAssignment, validateAssignments, explainUnfilled, createChecker } from "../../src/core/constraints.ts";
import { solve } from "../../src/core/solver.ts";
import { describeGap } from "../../src/core/explain.ts";
import { createSamplePlan, createEmptyPlan } from "../../src/core/sample.ts";
import { parseSaveFile, serializePlan, rosterToCsv, LIMITS } from "../../src/core/io.ts";
import type { EventPlan, Assignment } from "../../src/core/types.ts";
function small(): EventPlan {
    return { ...createEmptyPlan(), roles: [{ id: "r", name: "Role", requiredSkills: [] }], volunteers: ["a", "b"].map(id => ({ id, name: id, skills: [], availability: [{ start: 0, end: 1440 }], maxShifts: 5, maxMinutes: 1440 })), shifts: [{ id: "s", roleId: "r", label: "one", start: 60, end: 120, needed: 1 }, { id: "t", roleId: "r", label: "two", start: 120, end: 180, needed: 1 }] };
}
const assignment = (shiftId: string, volunteerId: string, locked = false): Assignment => ({ shiftId, volunteerId, locked });
test("strict times, touching boundaries, availability normalization, skills", () => {
    assert.equal(parseTime("24:00"), 1440);
    assert.equal(formatTime(1440), "24:00");
    for (const s of ["9:00", "24:01", "12:60", " 09:00", "-1:00"])
        assert.equal(parseTime(s), null);
    assert.equal(overlaps({ start: 0, end: 60 }, { start: 60, end: 120 }), false);
    assert.equal(overlaps({ start: 0, end: 61 }, { start: 60, end: 120 }), true);
    assert.deepEqual(parseAvailability("09:00\u201310:00;10:00-12:00"), { ok: true, intervals: [{ start: 540, end: 720 }] });
    assert.equal(parseAvailability("24:00-24:00").ok, false);
    assert.equal(parseAvailability(Array(21).fill("09:00-10:00").join(",")).ok, false);
    assert.deepEqual(normalizeSkills("First Aid, first aid, BAD!, z"), { skills: ["first-aid", "z"], rejected: [" BAD!"] });
});
test("every blocker, unknown ids and stable locked validation", () => {
    const p = small();
    p.roles[0]!.requiredSkills = ["aid"];
    p.volunteers[0]!.availability = [];
    p.volunteers[0]!.maxShifts = 0;
    p.volunteers[0]!.maxMinutes = 0;
    const kinds = checkAssignment(p, [assignment("s", "a"), assignment("s", "b"), assignment("t", "a")], "s", "a").map(b => b.kind);
    for (const k of ["missing-skill", "unavailable", "shift-cap", "minute-cap", "already-assigned", "shift-full"])
        assert.ok(kinds.includes(k as typeof kinds[number]));
    p.shifts[1]!.start = 90;
    assert.ok(checkAssignment(p, [assignment("t", "b")], "s", "b").some(b => b.kind === "overlap"));
    assert.deepEqual(checkAssignment(p, [], "?", "b"), [{ kind: "shift-full" }]);
    assert.deepEqual(checkAssignment(p, [], "s", "?"), [{ kind: "unavailable" }]);
    const q = small();
    assert.equal(validateAssignments(q, [assignment("s", "a"), assignment("s", "b", true)]).valid[0]!.volunteerId, "b");
});
test("sample partial, proof reason, fresh objects and immutable deterministic solve", () => {
    const p = createSamplePlan(), before = serializePlan(p), r = solve(p);
    assert.equal(r.status, "partial");
    assert.ok(r.unfilled.some(x => x.reason === "no-eligible-volunteer"));
    assert.equal(validateAssignments(p, r.assignments).invalid.length, 0);
    assert.ok(p.shifts.some(s => s.needed > 1 && r.assignments.filter(a => a.shiftId === s.id).length === s.needed));
    assert.equal(serializePlan(p), before);
    assert.deepEqual(solve({ ...p, volunteers: [...p.volunteers].reverse(), roles: [...p.roles].reverse(), shifts: [...p.shifts].reverse() }), r);
    assert.notEqual(createSamplePlan().volunteers, p.volunteers);
    assert.equal(explainUnfilled({ ...small(), volunteers: [] }, [])[0]!.reason, "no-eligible-volunteer");
});
test("locks preserved, invalid locked dropped, budget still valid, equal fairness", () => {
    const p = small();
    p.assignments = [assignment("s", "b", true), assignment("missing", "a", true), assignment("t", "a")];
    const r = solve(p);
    assert.ok(r.assignments.some(a => a.shiftId === "s" && a.volunteerId === "b" && a.locked));
    assert.equal(r.droppedLocked.length, 1);
    const tiny = solve(p, { maxSteps: 1 });
    assert.equal(tiny.status, "budget-exhausted");
    assert.equal(tiny.stepsUsed, 1);
    assert.equal(validateAssignments(p, tiny.assignments).invalid.length, 0);
    assert.deepEqual(solve(small()).loads.map(l => l.shifts), [1, 1]);
});
test("augmenting repair recovers a greedy trap", () => {
    let seed = 17;
    const random = () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    let found = false;
    for (let trial = 0; trial < 500 && !found; trial++) {
        const p = small();
        p.volunteers = Array.from({ length: 3 }, (_, i) => ({ id: `v${i}`, name: `v${i}`, skills: [], availability: [{ start: 0, end: 600 }], maxShifts: 1 + Math.floor(random() * 3), maxMinutes: 60 + Math.floor(random() * 4) * 60 }));
        p.shifts = Array.from({ length: 4 }, (_, i) => {
            const start = Math.floor(random() * 4) * 60;
            return { id: `s${i}`, roleId: "r", label: "", start, end: start + (1 + Math.floor(random() * 2)) * 60, needed: 1 };
        });
        const a: Assignment[] = [];
        while (true) {
            const choices = p.shifts.filter(s => a.filter(x => x.shiftId === s.id).length < s.needed).map(s => ({ s, vs: p.volunteers.filter(v => !checkAssignment(p, a, s.id, v.id).length) })).filter(c => c.vs.length).sort((x, y) => x.vs.length - y.vs.length || x.s.start - y.s.start || x.s.id.localeCompare(y.s.id));
            if (!choices.length)
                break;
            const c = choices[0]!;
            const load = (id: string) => a.filter(x => x.volunteerId === id).reduce((n, x) => {
                const s = p.shifts.find(s => s.id === x.shiftId)!;
                return n + s.end - s.start;
            }, 0);
            c.vs.sort((x, y) => load(x.id) - load(y.id) || a.filter(z => z.volunteerId === x.id).length - a.filter(z => z.volunteerId === y.id).length || x.id.localeCompare(y.id));
            a.push(assignment(c.s.id, c.vs[0]!.id));
        }
        const r = solve(p);
        if (r.filledSlots > a.length) {
            found = true;
            assert.equal(validateAssignments(p, r.assignments).invalid.length, 0);
        }
    }
    assert.ok(found, "bounded repair must improve at least one deterministic greedy trap");
});
test("seeded 60 random plans remain valid and permutation deterministic", () => {
    let seed = 918;
    const rand = () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    for (let n = 0; n < 60; n++) {
        const p = small();
        p.volunteers = Array.from({ length: 5 }, (_, i) => ({ id: `v${i}`, name: `V${i}`, skills: [], availability: [{ start: 0, end: 1440 }], maxShifts: 1 + Math.floor(rand() * 4), maxMinutes: 60 + Math.floor(rand() * 5) * 60 }));
        p.shifts = Array.from({ length: 6 }, (_, i) => {
            const start = Math.floor(rand() * 10) * 60;
            return { id: `s${i}`, roleId: "r", label: "", start, end: start + 60, needed: 1 + Math.floor(rand() * 2) };
        });
        const checker = createChecker(p);
        const r = solve(p);
        r.assignments.forEach(checker.add);
        for (const shift of p.shifts) for (const volunteer of p.volunteers) {
            assert.deepEqual(checker.check(shift.id, volunteer.id),
                checkAssignment(p, r.assignments, shift.id, volunteer.id));
        }
        assert.equal(validateAssignments(p, r.assignments).invalid.length, 0);
        assert.deepEqual(solve({ ...p, volunteers: [...p.volunteers].reverse(), shifts: [...p.shifts].reverse() }), r);
    }
});
test("JSON round trip, transactional validation and dangerous keys", () => {
    const p = createSamplePlan(), r = parseSaveFile(serializePlan(p));
    assert.ok(r.ok);
    assert.deepEqual(r.plan, p);
    for (const raw of ["null", "[]", "42", "\"x\"", "{\"__proto__\":{}}", "{\"constructor\":{}}", "{\"prototype\":{}}", "{"])
        assert.equal(parseSaveFile(raw).ok, false);
    assert.equal(parseSaveFile(" ".repeat(LIMITS.maxBytes + 1)).ok, false);
    const envelope = JSON.parse(serializePlan(small()));
    envelope.version = 2;
    const wrong = parseSaveFile(JSON.stringify(envelope));
    assert.ok(!wrong.ok && wrong.errors.some(e => e.includes("unsupported version")));
    for (const mutate of [(p: EventPlan) => {
            p.shifts[0]!.roleId = "missing";
        }, (p: EventPlan) => {
            p.roles.push({ ...p.roles[0]! });
        }, (p: EventPlan) => {
            p.shifts[0]!.end = 0;
        }, (p: EventPlan) => {
            p.shifts[1]!.start = 90;
            p.assignments = [assignment("s", "a"), assignment("t", "a")];
        }, (p: EventPlan) => {
            p.volunteers = Array(301).fill(p.volunteers[0]);
        }, (p: EventPlan) => {
            p.assignments = [assignment("s", "a"), assignment("s", "a")];
        }]) {
        const q = small();
        mutate(q);
        assert.equal(parseSaveFile(serializePlan(q)).ok, false);
    }
    const deep = JSON.parse(serializePlan(p));
    deep.extra = JSON.parse("{\"a\":{\"b\":{\"c\":{\"d\":{\"e\":{\"f\":{\"g\":{\"h\":{\"i\":1}}}}}}}}}");
    assert.equal(parseSaveFile(JSON.stringify(deep)).ok, false);
    const unknown = JSON.parse(serializePlan(p));
    unknown.extra = 1;
    const u = parseSaveFile(JSON.stringify(unknown));
    assert.ok(u.ok && u.warnings.length === 1);
});
test("CSV quotes, dangerous prefixes, CRLF and unfilled rows", () => {
    const p = small();
    p.volunteers[0]!.name = "=SUM(\"x\")";
    p.roles[0]!.name = "\uFF20role";
    const csv = rosterToCsv(p, [assignment("s", "a")]);
    assert.ok(csv.includes("\"'=SUM(\"\"x\"\")\""));
    assert.ok(csv.includes("\"'\uFF20role\""));
    assert.ok(csv.includes("\"(unfilled)\""));
    assert.ok(csv.endsWith("\r\n"));
    assert.equal(csv.split("\r\n").length, 4);
});

test('60 by 40 feasible fixture stays below default budget', t => {
    const plan = small();
    plan.volunteers = Array.from({ length: 60 }, (_, i) => ({ ...plan.volunteers[0]!, id: `v${i}` }));
    plan.shifts = Array.from({ length: 40 }, (_, i) => ({
        ...plan.shifts[0]!, id: `s${i}`, start: i * 30, end: (i + 1) * 30, needed: 2
    }));
    const result = solve(plan);
    t.diagnostic(`60x40 stepsUsed=${result.stepsUsed}`);
    assert.equal(result.status, 'all-filled');
    assert.ok(result.stepsUsed < 200_000);
    assert.equal(validateAssignments(plan, result.assignments).invalid.length, 0);
});

test('maximum-size overlapping plans remain valid at both budgets', t => {
    const plan = small();
    plan.volunteers = Array.from({ length: 300 }, (_, i) => ({
        ...plan.volunteers[0]!, id: `v${i}`, maxShifts: 1, maxMinutes: 60
    }));
    plan.shifts = Array.from({ length: 300 }, (_, i) => ({
        ...plan.shifts[0]!, id: `s${i}`, needed: 50
    }));
    for (const maxSteps of [200_000, 5_000_000]) {
        const start = performance.now();
        const result = solve(plan, { maxSteps });
        t.diagnostic(`300x300 budget=${maxSteps} durationMs=${performance.now() - start} steps=${result.stepsUsed}`);
        assert.equal(validateAssignments(plan, result.assignments).invalid.length, 0);
        assert.ok(result.stepsUsed <= maxSteps);
    }
});

test('eligible totals distinguish static shortage from competing locks', () => {
    const plan = small();
    plan.shifts[0]!.needed = 3;
    assert.equal(explainUnfilled({ ...plan, volunteers: [] }, [])[0]!.eligibleTotal, 0);
    const all = explainUnfilled(plan, [assignment('s', 'a'), assignment('s', 'b')])[0]!;
    assert.equal(all.eligibleTotal, 2);
    assert.equal(all.reason, 'no-eligible-volunteer');
    plan.shifts[1]!.start = 90;
    plan.volunteers.forEach(volunteer => { volunteer.maxShifts = 1; });
    const partlyFree = explainUnfilled(plan, [assignment('t', 'a', true)])[0]!;
    assert.equal(partlyFree.eligibleTotal, 2);
    assert.equal(partlyFree.reason, 'eligible-available');
    assert.deepEqual(partlyFree.blockers.find(entry => entry.volunteerId === 'b')!.blockers, []);
    plan.shifts[1]!.needed = 2;
    const blocked = explainUnfilled(plan, [assignment('t', 'a', true), assignment('t', 'b', true)])[0]!;
    assert.equal(blocked.eligibleTotal, 2);
    assert.equal(blocked.reason, 'blocked-by-assignments');
    assert.ok(blocked.blockers[0]!.blockers.some(blocker => blocker.kind === 'overlap'));
    assert.ok(blocked.blockers[0]!.blockers.some(blocker => blocker.kind === 'shift-cap'));
});

test('sample has genuine shortage and varied blocker kinds', () => {
    const plan = createSamplePlan();
    const result = solve(plan);
    assert.equal(result.status, 'partial');
    assert.ok(result.unfilled.some(slot => slot.reason === 'no-eligible-volunteer'
        && slot.eligibleTotal < plan.shifts.find(shift => shift.id === slot.shiftId)!.needed));
    assert.ok(result.unfilled.some(slot => new Set(slot.blockers.flatMap(entry =>
        entry.blockers.map(blocker => blocker.kind))).size >= 2));
});

test('CSV neutralizes whitespace formulas and preserves literal cells exactly', () => {
    const plan = small();
    const fixtures = [
        ['=1+1', "\"'=1+1\""],
        ['  =HYPERLINK("x")', "\"'  =HYPERLINK(\"\"x\"\")\""],
        ['\n=cmd', "\"'\n=cmd\""], ['\t+1', "\"'\t+1\""],
        ['　＠x', "\"'　＠x\""], ['-5', "\"'-5\""], ['Ana', '\"Ana\"'],
        ['a"quote"', '\"a\"\"quote\"\"\"'], ['a\nb', '\"a\nb\"']
    ];
    for (const [name, expected] of fixtures) {
        plan.volunteers[0]!.name = name!;
        assert.ok(rosterToCsv(plan, [assignment('s', 'a')]).includes(',' + expected + ','), name);
    }
});

test('import assignment failures name volunteer, shift, times and readable blockers', () => {
    const plan = small();
    plan.volunteers[0]!.name = 'Avery Chen';
    plan.shifts[1]!.start = 90;
    plan.assignments = [assignment('s', 'a'), assignment('t', 'a')];
    const result = parseSaveFile(serializePlan(plan));
    assert.ok(!result.ok);
    assert.ok(result.errors.includes(
        'plan.assignments[1]: Avery Chen cannot be added to "two" 01:30–03:00 — Overlaps "one" 01:00–02:00'));
});

test('tiny budget and pre-generate gaps report eligible-now volunteers, not invented conflicts', () => {
    const plan = createSamplePlan();
    const before = explainUnfilled(plan, []);
    assert.equal(before.length, plan.shifts.length);
    for (const slot of before) {
        const shift = plan.shifts.find(item => item.id === slot.shiftId)!;
        const availableNow = slot.blockers.filter(entry => entry.blockers.length === 0).length;
        assert.equal(slot.reason, slot.eligibleTotal === 0 ? 'no-eligible-volunteer' : 'eligible-available');
        assert.equal(availableNow, slot.eligibleTotal);
        assert.ok(describeGap(slot, shift).includes(`${availableNow} can be added now and 0 blocked`)
            || slot.reason === 'no-eligible-volunteer');
    }
    const tiny = solve(plan, { maxSteps: 1 });
    assert.equal(tiny.status, 'budget-exhausted');
    assert.equal(validateAssignments(plan, tiny.assignments).invalid.length, 0);
    for (const slot of tiny.unfilled) {
        const shift = plan.shifts.find(item => item.id === slot.shiftId)!;
        const availableNow = slot.blockers.filter(entry => entry.blockers.length === 0).length;
        const assigned = shift.needed - slot.missing;
        const blocked = slot.eligibleTotal - assigned - availableNow;
        assert.ok(blocked >= 0);
        if (availableNow > 0) {
            assert.equal(slot.reason, 'eligible-available');
            assert.match(describeGap(slot, shift), new RegExp(`${availableNow} can be added now and ${blocked} blocked`));
        }
    }
});
