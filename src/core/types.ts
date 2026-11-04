// ShiftFair shared contract (owned by the chief planner; workers must not change
// these shapes without approval). Pure type declarations only.
//
// Time model: a single event day. Times are minutes since local midnight,
// integers in [0, 1440]. A shift or availability window is the half-open
// interval [start, end) with start < end. Overnight/multi-day shifts are NOT
// supported (documented limitation). No time zones.

export type Id = string; // /^[A-Za-z0-9_-]{1,40}$/

export interface Interval {
  start: number; // minutes since midnight, integer, 0..1439
  end: number; // minutes since midnight, integer, 1..1440, end > start
}

export interface Role {
  id: Id;
  name: string; // 1..80 chars after trim
  requiredSkills: string[]; // normalized skill tags, deduped, sorted; 0..20
}

export interface Volunteer {
  id: Id;
  name: string; // 1..80 chars
  skills: string[]; // normalized skill tags, deduped, sorted; 0..20
  availability: Interval[]; // 0..20, sorted by start, non-overlapping (merged)
  maxShifts: number; // integer 0..50 (hard cap)
  maxMinutes: number; // integer 0..1440 (hard cap)
}

export interface Shift {
  id: Id;
  roleId: Id; // must reference an existing Role
  label: string; // 0..80 chars (may be empty)
  start: number;
  end: number; // same-day, end > start
  needed: number; // headcount, integer 1..50
}

export interface Assignment {
  shiftId: Id;
  volunteerId: Id;
  locked: boolean; // locked assignments are preserved by the solver
}

export interface EventPlan {
  name: string; // 1..80 chars
  dateLabel: string; // free text 0..40 chars, display only (e.g. "Sat 14 Nov"); not parsed
  roles: Role[];
  volunteers: Volunteer[];
  shifts: Shift[];
  assignments: Assignment[];
}

// Versioned file envelope for save/load and localStorage.
export interface SaveFileV1 {
  app: 'shiftfair';
  version: 1;
  plan: EventPlan;
}

// ---- Constraint checking -------------------------------------------------

export type Blocker =
  | { kind: 'missing-skill'; skills: string[] } // skills the role needs that the volunteer lacks
  | { kind: 'unavailable' } // shift interval not fully inside one availability window
  | { kind: 'overlap'; shiftId: Id } // already assigned to an overlapping shift
  | { kind: 'shift-cap'; current: number; max: number } // assigning would exceed maxShifts
  | { kind: 'minute-cap'; current: number; adding: number; max: number } // would exceed maxMinutes
  | { kind: 'already-assigned' } // already on this shift
  | { kind: 'shift-full' }; // shift already has `needed` assignees

// ---- Solver ----------------------------------------------------------------

export interface SolveOptions {
  maxSteps?: number; // search budget (candidate evaluations); default 200_000
}

export type SolveStatus =
  | 'all-filled' // every slot filled; all hard constraints satisfied
  | 'partial' // search completed within budget but some slots remain unfilled (heuristic; NOT a proof of infeasibility unless a slot's reason is 'no-eligible-volunteer')
  | 'budget-exhausted'; // step budget hit; result is the best found so far, valid but possibly improvable

export interface UnfilledSlot {
  shiftId: Id;
  missing: number; // needed - assigned
  // Every reason is relative to the CURRENT plan data (volunteers, skills,
  // availability windows, caps) and the given assignments. None is a claim
  // about the real world. Let free = eligibleTotal - (assigned on this shift).
  // 'no-eligible-volunteer': free === 0 — every volunteer not on this shift
  //   fails a static check (skill, availability, caps too small for this shift
  //   alone). The gap cannot be filled without changing the plan data.
  // 'eligible-available': at least one volunteer not on this shift could be
  //   added right now (empty current blockers), e.g. before Generate or after
  //   a tiny search budget ran out.
  // 'blocked-by-assignments': free > 0 but every such volunteer is currently
  //   blocked by overlap/caps from other (possibly locked) assignments.
  //   Heuristic: the gap may be resolvable by rearranging.
  // In every case, if free < missing, at least (missing - free) slots need
  // plan changes.
  reason: 'no-eligible-volunteer' | 'eligible-available' | 'blocked-by-assignments';
  eligibleTotal: number; // volunteers with no static blocker for this shift, including those already on it
  // One entry per volunteer NOT assigned to this shift, sorted by volunteer id.
  blockers: { volunteerId: Id; blockers: Blocker[] }[];
}

export interface VolunteerLoad {
  volunteerId: Id;
  shifts: number;
  minutes: number;
}

export interface SolveResult {
  status: SolveStatus;
  assignments: Assignment[]; // locked inputs (unchanged) + solver-chosen (locked:false); sorted by shiftId then volunteerId
  unfilled: UnfilledSlot[]; // sorted by shift start, then shift id
  loads: VolunteerLoad[]; // every volunteer, sorted by volunteer id
  stepsUsed: number;
  filledSlots: number;
  totalSlots: number;
  droppedLocked: Assignment[]; // locked inputs that were invalid and therefore not kept (should be empty for validated plans)
}

// ---- Import validation ------------------------------------------------------

export type ParseResult =
  | { ok: true; plan: EventPlan; warnings: string[] }
  | { ok: false; errors: string[] }; // human-readable, path-prefixed, capped at 20 messages
