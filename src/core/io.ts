import type { EventPlan, ParseResult, Assignment } from "./types.ts";
import { describeBlocker } from "./explain.ts";
import { normalizeSkills } from "./skills.ts";
import { isValidInterval, normalizeIntervals, formatTime } from "./time.ts";
import { validateAssignments, byId, buildIndex } from "./constraints.ts";
// Import/storage bounds. Counts bound every state the UI and solver can create:
// at most `shifts` shifts with `maxNeeded` people each, so a valid plan never
// has more than shifts * maxNeeded assignments. `maxBytes` is set above the
// pretty-printed size of a worst-case valid plan at these limits (about 3.6 MiB
// with maximum-length ids, names, skills and JSON-escaped characters; see
// test/core/limits.test.ts), so every supported plan exported as JSON can be
// imported again.
export const LIMITS = {
    maxBytes: 4 * 1024 * 1024,
    roles: 50,
    volunteers: 300,
    shifts: 300,
    assignments: 300 * 50,
    nameLength: 80,
    labelLength: 80,
    dateLabelLength: 40,
    skillsPerItem: 20,
    availabilityWindows: 20,
    maxNeeded: 50,
    maxShiftsCap: 50,
    maxDepth: 8,
} as const;

export function serializePlan(plan: EventPlan): string {
    return JSON.stringify({ app: "shiftfair", version: 1, plan }, null, 2);
}
export function parseSaveFile(text: string): ParseResult {
    const errors: string[] = [], warnings: string[] = [];
    const error = (p: string, m: string) => {
        if (errors.length < 20)
            errors.push(`${p}: ${m}`);
    };
    if (new TextEncoder().encode(text).length > LIMITS.maxBytes)
        return { ok: false, errors: [`file: larger than the ${LIMITS.maxBytes / (1024 * 1024)} MiB limit`] };
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    }
    catch {
        return { ok: false, errors: ["file: invalid JSON"] };
    }
    function walk(x: unknown, d: number, p: string): void {
        if (d > LIMITS.maxDepth) {
            error(p, "maximum depth exceeded");
            return;
        }
        if (x && typeof x === "object")
            for (const k of Object.keys(x)) {
                if (["__proto__", "constructor", "prototype"].includes(k))
                    error(p, "forbidden key " + k);
                walk((x as Record<string, unknown>)[k], d + 1, p + "." + k);
            }
    }
    walk(raw, 0, "file");
    if (errors.length)
        return { ok: false, errors };
    let unknown = false;
    function obj(x: unknown, p: string, keys: string[]): Record<string, unknown> {
        if (!x || typeof x !== "object" || Array.isArray(x)) {
            error(p, "expected object");
            return {};
        }
        const o = x as Record<string, unknown>;
        if (Object.keys(o).some(k => !keys.includes(k)))
            unknown = true;
        return o;
    }
    function str(x: unknown, p: string, min: number, max: number): string {
        if (typeof x !== "string" || x.trim().length < min || x.length > max) {
            error(p, `expected string of length ${min}..${max}`);
            return "";
        }
        return x;
    }
    function num(x: unknown, p: string, min: number, max: number): number {
        if (typeof x !== "number" || !Number.isInteger(x) || x < min || x > max) {
            error(p, `expected integer ${min}..${max}`);
            return min;
        }
        return x;
    }
    function arr(x: unknown, p: string, max: number): unknown[] {
        if (!Array.isArray(x)) {
            error(p, "expected array");
            return [];
        }
        if (x.length > max) {
            error(p, "too many items");
            return [];
        }
        return x;
    }
    function id(x: unknown, p: string): string {
        const s = str(x, p, 1, 40);
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(s))
            error(p, "invalid id");
        return s;
    }
    function skills(x: unknown, p: string): string[] {
        const a = arr(x, p, 20);
        if (a.some(s => typeof s !== "string")) {
            error(p, "expected skill strings");
            return [];
        }
        const n = normalizeSkills(a as string[]);
        if (n.rejected.length)
            error(p, "invalid skill");
        return n.skills;
    }
    const e = obj(raw, "file", ["app", "version", "plan"]);
    if (e.app !== "shiftfair")
        error("file.app", "expected shiftfair");
    if (e.version !== 1)
        error("file.version", "unsupported version");
    const p = obj(e.plan, "plan", ["name", "dateLabel", "roles", "volunteers", "shifts", "assignments"]);
    const plan: EventPlan = {
        name: str(p.name, "plan.name", 1, LIMITS.nameLength),
        dateLabel: str(p.dateLabel, "plan.dateLabel", 0, LIMITS.dateLabelLength),
        roles: [],
        volunteers: [],
        shifts: [],
        assignments: [],
    };
    plan.roles = arr(p.roles, "plan.roles", LIMITS.roles).map((x, i) => {
        const path = `plan.roles[${i}]`, o = obj(x, path, ["id", "name", "requiredSkills"]);
        return {
            id: id(o.id, path + ".id"),
            name: str(o.name, path + ".name", 1, LIMITS.nameLength),
            requiredSkills: skills(o.requiredSkills, path + ".requiredSkills"),
        };
    });
    plan.volunteers = arr(p.volunteers, "plan.volunteers", LIMITS.volunteers).map((x, i) => {
        const path = `plan.volunteers[${i}]`;
        const o = obj(x, path, ["id", "name", "skills", "availability", "maxShifts", "maxMinutes"]);
        const windows = arr(o.availability, path + ".availability", 20).map((w, j) => {
            const wp = path + `.availability[${j}]`, v = obj(w, wp, ["start", "end"]);
            const interval = { start: num(v.start, wp + ".start", 0, 1439), end: num(v.end, wp + ".end", 1, 1440) };
            if (!isValidInterval(interval))
                error(wp, "invalid interval");
            return interval;
        });
        const normalized = normalizeIntervals(windows);
        if (JSON.stringify(normalized) !== JSON.stringify(windows))
            warnings.push(path + ".availability: windows normalized");
        return {
            id: id(o.id, path + ".id"),
            name: str(o.name, path + ".name", 1, LIMITS.nameLength),
            skills: skills(o.skills, path + ".skills"),
            availability: normalized,
            maxShifts: num(o.maxShifts, path + ".maxShifts", 0, LIMITS.maxShiftsCap),
            maxMinutes: num(o.maxMinutes, path + ".maxMinutes", 0, 1440),
        };
    });
    plan.shifts = arr(p.shifts, "plan.shifts", LIMITS.shifts).map((x, i) => {
        const path = `plan.shifts[${i}]`, o = obj(x, path, ["id", "roleId", "label", "start", "end", "needed"]);
        const s = {
            id: id(o.id, path + ".id"),
            roleId: id(o.roleId, path + ".roleId"),
            label: str(o.label, path + ".label", 0, LIMITS.labelLength),
            start: num(o.start, path + ".start", 0, 1439),
            end: num(o.end, path + ".end", 1, 1440),
            needed: num(o.needed, path + ".needed", 1, LIMITS.maxNeeded),
        };
        if (!isValidInterval(s))
            error(path, "invalid interval");
        if (!plan.roles.some(r => r.id === s.roleId))
            error(path + ".roleId", "unknown role");
        return s;
    });
    plan.assignments = arr(p.assignments, "plan.assignments", LIMITS.assignments).map((x, i) => {
        const path = `plan.assignments[${i}]`, o = obj(x, path, ["shiftId", "volunteerId", "locked"]);
        if (typeof o.locked !== "boolean")
            error(path + ".locked", "expected boolean");
        return {
            shiftId: id(o.shiftId, path + ".shiftId"),
            volunteerId: id(o.volunteerId, path + ".volunteerId"),
            locked: o.locked === true,
        };
    });
    for (const key of ["roles", "volunteers", "shifts"] as const) {
        const seen = new Set<string>();
        plan[key].forEach((v, i) => {
            if (seen.has(v.id))
                error(`plan.${key}[${i}].id`, "duplicate id");
            seen.add(v.id);
        });
    }
    const index = buildIndex(plan);
    if (!errors.length)
        for (const invalid of validateAssignments(plan).invalid) {
            const i = plan.assignments.indexOf(invalid.assignment);
            const entry = invalid.assignment;
            const shift = index.shiftById.get(entry.shiftId);
            const volunteer = index.volunteerById.get(entry.volunteerId);
            if (!shift)
                error(`plan.assignments[${i}].shiftId`, "unknown shift");
            else if (!volunteer)
                error(`plan.assignments[${i}].volunteerId`, "unknown volunteer");
            else if (invalid.blockers.some(blocker => blocker.kind === "already-assigned")) {
                error(`plan.assignments[${i}]`, "duplicate assignment (already-assigned)");
            }
            else {
                const label = shift.label || index.roleById.get(shift.roleId)?.name || shift.id;
                const reasons = invalid.blockers.map(blocker => describeBlocker(blocker, index)).join("; ");
                const when = `${formatTime(shift.start)}–${formatTime(shift.end)}`;
                error(`plan.assignments[${i}]`, `${volunteer.name} cannot be added to "${label}" ${when} — ${reasons}`);
            }
        }
    if (errors.length)
        return { ok: false, errors };
    if (unknown)
        warnings.push("file: unknown fields ignored");
    return { ok: true, plan, warnings };
}
const CSV_HEADER = ["Shift ID", "Role", "Shift label", "Start", "End", "Volunteer ID", "Volunteer", "Locked"];

// Spreadsheet formula protection: prefix "'" when a cell starts with TAB/CR/LF,
// or when its first non-whitespace character is a formula marker.
function csvCell(value: string): string {
    const dangerous = /^[\t\r\n]/u.test(value) || /^[=+\-@＝＋－＠]/u.test(value.replace(/^\s*/u, ""));
    const text = dangerous ? `'${value}` : value;
    return `"${text.replace(/"/g, '""')}"`;
}

export function rosterToCsv(p: EventPlan, a: Assignment[]): string {
    const roleNames = new Map(p.roles.map(role => [role.id, role.name]));
    const volunteerNames = new Map(p.volunteers.map(volunteer => [volunteer.id, volunteer.name]));
    const byShift = new Map<string, Assignment[]>();
    for (const entry of a) {
        const list = byShift.get(entry.shiftId) ?? [];
        list.push(entry);
        byShift.set(entry.shiftId, list);
    }
    const byVolunteerName = (left: Assignment, right: Assignment): number => {
        const leftName = volunteerNames.get(left.volunteerId) ?? "";
        const rightName = volunteerNames.get(right.volunteerId) ?? "";
        if (leftName !== rightName) {
            return leftName < rightName ? -1 : 1;
        }
        return byId({ id: left.volunteerId }, { id: right.volunteerId });
    };
    const rows: string[][] = [CSV_HEADER];
    for (const shift of [...p.shifts].sort((left, right) => left.start - right.start || byId(left, right))) {
        const assigned = [...(byShift.get(shift.id) ?? [])].sort(byVolunteerName);
        const prefix = [
            shift.id,
            roleNames.get(shift.roleId) ?? "",
            shift.label,
            formatTime(shift.start),
            formatTime(shift.end),
        ];
        for (const entry of assigned) {
            rows.push([...prefix, entry.volunteerId, volunteerNames.get(entry.volunteerId) ?? "", String(entry.locked)]);
        }
        for (let slot = assigned.length; slot < shift.needed; slot++) {
            rows.push([...prefix, "", "(unfilled)", ""]);
        }
    }
    return rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
