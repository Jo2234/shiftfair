import type { Blocker, SolveResult, UnfilledSlot, Shift } from "./types.ts";
import type { PlanIndex } from "./constraints.ts";
import { formatTime } from "./time.ts";
export function describeBlocker(b: Blocker, i: PlanIndex): string {
    switch (b.kind) {
        case "missing-skill": return `Missing skill: ${b.skills.join(", ")}`;
        case "unavailable": return "Not available for the whole shift";
        case "overlap": {
            const s = i.shiftById.get(b.shiftId);
            if (!s) {
                return `Overlaps shift ${b.shiftId}`;
            }
            const name = s.label || i.roleById.get(s.roleId)?.name || s.id;
            return `Overlaps "${name}" ${formatTime(s.start)}–${formatTime(s.end)}`;
        }
        case "shift-cap": return `Shift limit reached (${b.current} of ${b.max})`;
        case "minute-cap": return `Minute limit: ${b.current} + ${b.adding} > ${b.max}`;
        case "already-assigned": return "Already on this shift";
        case "shift-full": return "Shift is full";
    }
}
export function describeStatus(result: SolveResult): string {
    if (result.status === "all-filled") {
        return `All ${result.totalSlots} slots filled; every hard constraint in this plan is satisfied.`
            + ' Fairness is a heuristic balance, not a guaranteed optimum.';
    }
    if (result.status === "budget-exhausted") {
        return `Search budget reached after ${result.stepsUsed} steps; ${result.filledSlots} of ${result.totalSlots}`
            + ' slots filled. The roster obeys every hard constraint but coverage and fairness may be improvable.';
    }
    return `${result.filledSlots} of ${result.totalSlots} slots filled. Gaps marked "not enough eligible volunteers"`
        + ' cannot be filled with the current plan data (skills, availability, limits); other gaps might be fillable'
        + ' by a different arrangement — the search is heuristic, not exhaustive.';
}
// Summary of one unfilled shift. Counts come from the slot itself:
// assigned = needed - missing; free = eligibleTotal - assigned (eligible people
// not on this shift); availableNow = those with no current blocker; the rest
// of `free` are blocked by their other assignments (overlap or limits).
export function describeGap(slot: UnfilledSlot, shift: Shift): string {
    const assigned = shift.needed - slot.missing;
    const free = Math.max(0, slot.eligibleTotal - assigned);
    const availableNow = slot.blockers.filter(entry => entry.blockers.length === 0).length;
    const blocked = Math.max(0, free - availableNow);
    const changes = 'Add volunteers or change skills, availability, limits or headcount.';
    const needs = `Needs ${slot.missing} more.`;
    if (slot.reason === 'no-eligible-volunteer') {
        if (slot.eligibleTotal === 0) {
            return `${needs} No volunteer in this plan has the required skills, availability and limits`
                + ` for this shift. ${changes}`;
        }
        const verb = slot.eligibleTotal === 1 ? 'has' : 'have';
        const them = slot.eligibleTotal === 1 ? 'that volunteer is' : 'all of them are';
        return `${needs} Only ${plural(slot.eligibleTotal, 'volunteer')} in this plan ${verb} the required skills,`
            + ` availability and limits for this shift, and ${them} already on it. ${changes}`;
    }
    const qualify = slot.eligibleTotal === 1 ? 'qualifies' : 'qualify';
    let text = `${needs} ${plural(slot.eligibleTotal, 'volunteer')} in this plan ${qualify}: ${assigned} already on`
        + ` this shift, ${availableNow} can be added now and ${blocked} blocked by other assignments`
        + ' (overlap or limits).';
    if (availableNow > 0) {
        text += ' Generate the roster or add a volunteer manually.';
    }
    if (blocked > 0) {
        text += ' Moving or unlocking other assignments may help; the search is heuristic, so this is not proof'
            + ' either way.';
    }
    if (free < slot.missing) {
        const verbNeed = slot.missing - free === 1 ? 'needs' : 'need';
        text += ` Even then, at most ${free} more can be added, so at least`
            + ` ${plural(slot.missing - free, 'slot')} ${verbNeed} plan changes.`;
    }
    return text;
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}
