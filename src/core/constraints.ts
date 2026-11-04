import type { EventPlan, Role, Volunteer, Shift, Assignment, Blocker, VolunteerLoad, UnfilledSlot } from "./types.ts";
import { overlaps } from "./time.ts";
export interface PlanIndex {
    roleById: Map<string, Role>;
    volunteerById: Map<string, Volunteer>;
    shiftById: Map<string, Shift>;
}
export const byId = (a: {
    id: string;
}, b: {
    id: string;
}): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
export function buildIndex(p: EventPlan): PlanIndex {
    return {
        roleById: new Map(p.roles.map(role => [role.id, role])),
        volunteerById: new Map(p.volunteers.map(volunteer => [volunteer.id, volunteer])),
        shiftById: new Map(p.shifts.map(shift => [shift.id, shift])),
    };
}
export function staticBlockers(i: PlanIndex, v: Volunteer, s: Shift): Blocker[] {
    const b: Blocker[] = [];
    const skills = (i.roleById.get(s.roleId)?.requiredSkills ?? []).filter(x => !v.skills.includes(x)).sort();
    if (skills.length)
        b.push({ kind: "missing-skill", skills });
    if (!v.availability.some(w => w.start <= s.start && w.end >= s.end))
        b.push({ kind: "unavailable" });
    if (v.maxShifts < 1)
        b.push({ kind: "shift-cap", current: 0, max: v.maxShifts });
    if (s.end - s.start > v.maxMinutes)
        b.push({ kind: "minute-cap", current: 0, adding: s.end - s.start, max: v.maxMinutes });
    return b;
}
// Reusable constraint checker for one plan: builds the index and static
// eligibility cache once and tracks a working assignment set incrementally.
// `check` gives the same blockers as `checkAssignment` against that set.
export function createChecker(plan: EventPlan) {
    const index = buildIndex(plan);
    // Working set; Set so add/remove stay cheap on large plans.
    const assignments = new Set<Assignment>();
    const byVolunteer = new Map<string, Assignment[]>();
    const byShift = new Map<string, Assignment[]>();
    const loads = new Map<string, VolunteerLoad>(
        plan.volunteers.map(volunteer => [volunteer.id, { volunteerId: volunteer.id, shifts: 0, minutes: 0 }]),
    );
    const eligibility = new Map<string, Map<string, Blocker[]>>();
    function staticFor(shiftId: string, volunteerId: string): Blocker[] {
        let row = eligibility.get(shiftId);
        if (!row) {
            row = new Map();
            eligibility.set(shiftId, row);
        }
        let blockers = row.get(volunteerId);
        if (!blockers) {
            const shift = index.shiftById.get(shiftId);
            const volunteer = index.volunteerById.get(volunteerId);
            if (!shift) {
                blockers = [{ kind: "shift-full" }];
            } else if (!volunteer) {
                blockers = [{ kind: "unavailable" }];
            } else {
                blockers = staticBlockers(index, volunteer, shift);
            }
            row.set(volunteerId, blockers);
        }
        return blockers;
    }
    function add(assignment: Assignment): void {
        assignments.add(assignment);
        for (const [map, key] of [[byVolunteer, assignment.volunteerId], [byShift, assignment.shiftId]] as const) {
            const entries = map.get(key) ?? [];
            entries.push(assignment);
            map.set(key, entries);
        }
        const load = loads.get(assignment.volunteerId);
        const shift = index.shiftById.get(assignment.shiftId);
        if (load) {
            load.shifts++;
            load.minutes += shift ? shift.end - shift.start : 0;
        }
    }
    function remove(assignment: Assignment): void {
        if (!assignments.delete(assignment))
            return;
        for (const [map, key] of [[byVolunteer, assignment.volunteerId], [byShift, assignment.shiftId]] as const) {
            const entries = map.get(key)!;
            entries.splice(entries.indexOf(assignment), 1);
        }
        const load = loads.get(assignment.volunteerId);
        const shift = index.shiftById.get(assignment.shiftId);
        if (load) {
            load.shifts--;
            load.minutes -= shift ? shift.end - shift.start : 0;
        }
    }
    function check(shiftId: string, volunteerId: string): Blocker[] {
        const shift = index.shiftById.get(shiftId);
        const volunteer = index.volunteerById.get(volunteerId);
        if (!shift)
            return [{ kind: "shift-full" }];
        if (!volunteer)
            return [{ kind: "unavailable" }];
        const blockers: Blocker[] = staticFor(shiftId, volunteerId)
            .filter(blocker => blocker.kind !== "shift-cap" && blocker.kind !== "minute-cap");
        const own = byVolunteer.get(volunteerId) ?? [];
        let identical = 0;
        let otherShifts = 0;
        let otherMinutes = 0;
        let clash: Shift | undefined; // first overlapping shift by start, then id
        for (const entry of own) {
            if (entry.shiftId === shiftId) {
                identical++;
                continue;
            }
            const other = index.shiftById.get(entry.shiftId);
            if (!other) {
                continue;
            }
            otherShifts++;
            otherMinutes += other.end - other.start;
            const earlier = !clash || (other.start - clash.start || byId(other, clash)) < 0;
            if (overlaps(other, shift) && earlier) {
                clash = other;
            }
        }
        if (identical) {
            blockers.push({ kind: "already-assigned" });
        }
        if ((byShift.get(shiftId)?.length ?? 0) - identical >= shift.needed) {
            blockers.push({ kind: "shift-full" });
        }
        if (clash) {
            blockers.push({ kind: "overlap", shiftId: clash.id });
        }
        if (otherShifts >= volunteer.maxShifts) {
            blockers.push({ kind: "shift-cap", current: otherShifts, max: volunteer.maxShifts });
        }
        const adding = shift.end - shift.start;
        if (otherMinutes + adding > volunteer.maxMinutes) {
            blockers.push({ kind: "minute-cap", current: otherMinutes, adding, max: volunteer.maxMinutes });
        }
        return blockers;
    }
    return { index, assignments, byVolunteer, byShift, loads, staticFor, check, add, remove };
}
export function checkAssignment(plan: EventPlan, assignments: Assignment[], shiftId: string, volunteerId: string): Blocker[] {
    const checker = createChecker(plan);
    assignments.forEach(checker.add);
    return checker.check(shiftId, volunteerId);
}
export function validateAssignments(plan: EventPlan, assignments: Assignment[] = plan.assignments) {
    const checker = createChecker(plan);
    const valid: Assignment[] = [];
    const invalid: {
        assignment: Assignment;
        blockers: Blocker[];
    }[] = [];
    for (const assignment of [...assignments].sort((left, right) => Number(right.locked) - Number(left.locked))) {
        const blockers = checker.check(assignment.shiftId, assignment.volunteerId);
        if (blockers.length)
            invalid.push({ assignment, blockers });
        else {
            const copy = { ...assignment };
            valid.push(copy);
            checker.add(copy);
        }
    }
    return { valid, invalid };
}
export function computeLoads(plan: EventPlan, assignments: Assignment[]): VolunteerLoad[] {
    const checker = createChecker(plan);
    assignments.forEach(checker.add);
    return [...checker.loads.values()].sort((left, right) => byId({ id: left.volunteerId }, { id: right.volunteerId }));
}
export function explainUnfilled(plan: EventPlan, assignments: Assignment[]): UnfilledSlot[] {
    const checker = createChecker(plan);
    assignments.forEach(checker.add);
    const volunteers = [...plan.volunteers].sort(byId);
    const shifts = [...plan.shifts].sort((left, right) => left.start - right.start || byId(left, right));
    return shifts.flatMap(shift => {
        const assigned = checker.byShift.get(shift.id) ?? [];
        const missing = shift.needed - assigned.length;
        if (missing <= 0) {
            return [];
        }
        const assignedIds = new Set(assigned.map(entry => entry.volunteerId));
        const eligibleTotal = volunteers.filter(volunteer => !checker.staticFor(shift.id, volunteer.id).length).length;
        const blockers = volunteers
            .filter(volunteer => !assignedIds.has(volunteer.id))
            .map(volunteer => ({ volunteerId: volunteer.id, blockers: checker.check(shift.id, volunteer.id) }));
        const free = eligibleTotal - assigned.length;
        let reason: UnfilledSlot['reason'] = 'blocked-by-assignments';
        if (free <= 0) {
            reason = 'no-eligible-volunteer';
        } else if (blockers.some(entry => entry.blockers.length === 0)) {
            reason = 'eligible-available';
        }
        return [{ shiftId: shift.id, missing, eligibleTotal, reason, blockers }];
    });
}
