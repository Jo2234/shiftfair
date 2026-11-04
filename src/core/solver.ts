import type { EventPlan, Assignment, SolveOptions, SolveResult, Shift, Volunteer } from './types.ts';
import { byId, createChecker, validateAssignments, computeLoads, explainUnfilled } from './constraints.ts';

export const DEFAULT_MAX_STEPS = 200_000;
export const MAX_STEPS_LIMIT = 5_000_000;
const REPAIR_DEPTH = 3;

function byPair(left: Assignment, right: Assignment): number {
    return byId({ id: left.shiftId }, { id: right.shiftId }) || byId({ id: left.volunteerId }, { id: right.volunteerId });
}

function clampBudget(requested: number | undefined): number {
    const value = requested !== undefined && Number.isFinite(requested) ? requested : DEFAULT_MAX_STEPS;
    return Math.min(MAX_STEPS_LIMIT, Math.max(1, Math.floor(value)));
}

// Bounded deterministic heuristic: greedy fill, depth-limited augmenting
// repair, then a fairness pass. Never claims optimality.
//
// Step accounting (the search budget): one step per static eligibility
// evaluation of a (shift, volunteer) pair, and one step per dynamic candidate
// check against the current working roster. Volunteers with no assignments
// need no dynamic check (their blockers are exactly the static ones), so that
// work is skipped rather than counted. When steps reach the budget the search
// stops and reports 'budget-exhausted'; the roster returned is still valid.
//
// All search state lives in one incremental checker; trial moves are applied
// in place and undone, so each step costs time proportional to one
// volunteer's own assignments rather than to the whole roster.
export function solve(plan: EventPlan, options: SolveOptions = {}): SolveResult {
    const maxSteps = clampBudget(options.maxSteps);
    const lockedInput = plan.assignments.filter(entry => entry.locked).sort(byPair);
    const checkedLocks = validateAssignments(plan, lockedInput);

    const checker = createChecker(plan);
    checkedLocks.valid.forEach(checker.add);

    const volunteers = [...plan.volunteers].sort(byId);
    const shifts = [...plan.shifts].sort((left, right) => left.start - right.start || byId(left, right));
    let steps = 0;
    const budgetLeft = (): boolean => steps < maxSteps;

    // One counted dynamic candidate check.
    const canAdd = (shiftId: string, volunteerId: string): boolean => {
        if (!budgetLeft()) {
            return false;
        }
        steps++;
        return checker.check(shiftId, volunteerId).length === 0;
    };
    const assignedCount = (shift: Shift): number => checker.byShift.get(shift.id)?.length ?? 0;
    const isOpen = (shift: Shift): boolean => assignedCount(shift) < shift.needed;
    const isOnShift = (shiftId: string, volunteerId: string): boolean =>
        (checker.byVolunteer.get(volunteerId) ?? []).some(entry => entry.shiftId === shiftId);
    const hasAssignments = (volunteerId: string): boolean => (checker.byVolunteer.get(volunteerId)?.length ?? 0) > 0;

    // 1. Static eligibility, computed once.
    const eligible = new Map<string, Set<string>>();
    for (const shift of shifts) {
        const ids = new Set<string>();
        eligible.set(shift.id, ids);
        for (const volunteer of volunteers) {
            if (!budgetLeft()) {
                break;
            }
            steps++;
            if (checker.staticFor(shift.id, volunteer.id).length === 0) {
                ids.add(volunteer.id);
            }
        }
    }

    // 2. Greedy: most constrained open shift first (fewest current candidates,
    // then earlier start, then id); least-loaded candidate (minutes, shifts, id).
    const candidates = new Map<string, Set<string>>();
    for (const shift of shifts) {
        if (!isOpen(shift)) {
            continue;
        }
        const current = new Set<string>();
        candidates.set(shift.id, current);
        for (const volunteerId of eligible.get(shift.id) ?? []) {
            if (!hasAssignments(volunteerId) || canAdd(shift.id, volunteerId)) {
                current.add(volunteerId);
            }
        }
    }
    while (budgetLeft()) {
        let best: Shift | undefined;
        for (const shift of shifts) {
            const size = candidates.get(shift.id)?.size ?? 0;
            if (size > 0 && (!best || size < candidates.get(best.id)!.size)) {
                best = shift;
            }
        }
        if (!best) {
            break;
        }
        let chosen: string | undefined;
        for (const volunteerId of candidates.get(best.id)!) {
            if (chosen === undefined || lighter(volunteerId, chosen)) {
                chosen = volunteerId;
            }
        }
        checker.add({ shiftId: best.id, volunteerId: chosen!, locked: false });
        // Only the chosen volunteer's candidacy (and the shift's fullness) changed.
        for (const shift of shifts) {
            const current = candidates.get(shift.id);
            if (!current) {
                continue;
            }
            if (!isOpen(shift)) {
                candidates.delete(shift.id);
            } else if (current.has(chosen!) && !canAdd(shift.id, chosen!)) {
                current.delete(chosen!);
            }
        }
    }

    function lighter(leftId: string, rightId: string): boolean {
        const left = checker.loads.get(leftId)!;
        const right = checker.loads.get(rightId)!;
        if (left.minutes !== right.minutes) {
            return left.minutes < right.minutes;
        }
        if (left.shifts !== right.shifts) {
            return left.shifts < right.shifts;
        }
        return leftId < rightId;
    }

    // 3. Repair: depth-limited augmenting moves. A statically eligible volunteer
    // gives up all their unlocked assignments to take this slot; each freed slot
    // must be refilled recursively. Only strict increases in filled slots are kept.
    type Change = { kind: 'add' | 'remove'; entry: Assignment };
    const journal: Change[] = [];
    const apply = (kind: Change['kind'], entry: Assignment): void => {
        if (kind === 'add') {
            checker.add(entry);
        } else {
            checker.remove(entry);
        }
        journal.push({ kind, entry });
    };
    const rollback = (mark: number): void => {
        while (journal.length > mark) {
            const change = journal.pop()!;
            if (change.kind === 'add') {
                checker.remove(change.entry);
            } else {
                checker.add(change.entry);
            }
        }
    };

    function fill(shift: Shift, depth: number, path: Set<string>): boolean {
        for (const volunteer of volunteers) {
            if (!budgetLeft()) {
                return false;
            }
            if (canAdd(shift.id, volunteer.id)) {
                apply('add', { shiftId: shift.id, volunteerId: volunteer.id, locked: false });
                return true;
            }
            if (depth === 0 || path.has(volunteer.id) || !eligible.get(shift.id)?.has(volunteer.id)
                || isOnShift(shift.id, volunteer.id)) {
                continue;
            }
            const displaced = (checker.byVolunteer.get(volunteer.id) ?? [])
                .filter(entry => !entry.locked)
                .sort(byPair);
            if (!displaced.length) {
                continue;
            }
            const mark = journal.length;
            displaced.forEach(entry => apply('remove', entry));
            if (!canAdd(shift.id, volunteer.id)) {
                rollback(mark);
                continue;
            }
            apply('add', { shiftId: shift.id, volunteerId: volunteer.id, locked: false });
            const seen = new Set(path).add(volunteer.id);
            const refilled = displaced.every(entry =>
                fill(checker.index.shiftById.get(entry.shiftId)!, depth - 1, seen));
            if (refilled) {
                return true;
            }
            rollback(mark);
        }
        return false;
    }

    for (const shift of shifts) {
        while (budgetLeft() && isOpen(shift)) {
            const mark = journal.length;
            if (!fill(shift, REPAIR_DEPTH, new Set())) {
                rollback(mark);
                break;
            }
            journal.length = 0;
        }
    }

    // 4. Fairness: move or swap unlocked work of the highest-minute volunteer
    // when that strictly reduces the minute spread among volunteers with any
    // availability. Filled-slot count never changes.
    const balanced: Volunteer[] = volunteers.filter(volunteer => volunteer.availability.length > 0);
    const spread = (): number => {
        if (!balanced.length) {
            return 0;
        }
        let high = -Infinity;
        let low = Infinity;
        for (const volunteer of balanced) {
            const minutes = checker.loads.get(volunteer.id)!.minutes;
            high = Math.max(high, minutes);
            low = Math.min(low, minutes);
        }
        return high - low;
    };
    const heaviest = (): string | undefined => {
        let result: string | undefined;
        for (const volunteer of volunteers) {
            if (result === undefined || checker.loads.get(volunteer.id)!.minutes > checker.loads.get(result)!.minutes) {
                result = volunteer.id;
            }
        }
        return result;
    };

    // Tries moving `entry` to `volunteerId` (and optionally `swap` back to the
    // original volunteer). Keeps the change only if the spread drops.
    function tryImprove(entry: Assignment, volunteerId: string, before: number, swap?: Assignment): boolean {
        const mark = journal.length;
        apply('remove', entry);
        if (swap) {
            apply('remove', swap);
        }
        if (canAdd(entry.shiftId, volunteerId)) {
            apply('add', { ...entry, volunteerId });
            if (!swap || canAdd(swap.shiftId, entry.volunteerId)) {
                if (swap) {
                    apply('add', { ...swap, volunteerId: entry.volunteerId });
                }
                if (spread() < before) {
                    journal.length = mark;
                    return true;
                }
            }
        }
        rollback(mark);
        return false;
    }

    let improved = true;
    while (improved && budgetLeft()) {
        improved = false;
        const before = spread();
        const high = heaviest();
        const movable = (checker.byVolunteer.get(high ?? '') ?? []).filter(entry => !entry.locked).sort(byPair);
        search:
        for (const entry of movable) {
            for (const volunteer of volunteers) {
                if (!budgetLeft()) {
                    break search;
                }
                if (tryImprove(entry, volunteer.id, before)) {
                    improved = true;
                    break search;
                }
                const swaps = (checker.byVolunteer.get(volunteer.id) ?? [])
                    .filter(other => !other.locked && other.shiftId !== entry.shiftId)
                    .sort(byPair);
                for (const other of swaps) {
                    if (tryImprove(entry, volunteer.id, before, other)) {
                        improved = true;
                        break search;
                    }
                }
            }
        }
    }

    const assignments = [...checker.assignments].sort(byPair);
    const totalSlots = plan.shifts.reduce((total, shift) => total + shift.needed, 0);
    let status: SolveResult['status'] = 'partial';
    if (steps >= maxSteps) {
        status = 'budget-exhausted';
    } else if (assignments.length === totalSlots) {
        status = 'all-filled';
    }
    return {
        status,
        assignments,
        unfilled: explainUnfilled(plan, assignments),
        loads: computeLoads(plan, assignments),
        stepsUsed: steps,
        filledSlots: assignments.length,
        totalSlots,
        droppedLocked: checkedLocks.invalid.map(invalid => ({ ...invalid.assignment })),
    };
}
