import type { Interval } from "./types.ts";
export function parseTime(s: string): number | null {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(s))
        return null;
    return Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
}
export function formatTime(m: number): string {
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
export function isValidInterval(i: Interval): boolean {
    return Number.isInteger(i.start) && Number.isInteger(i.end) && i.start >= 0 && i.start < i.end && i.end <= 1440;
}
export function overlaps(a: Interval, b: Interval): boolean {
    return a.start < b.end && b.start < a.end;
}
export function normalizeIntervals(list: Interval[]): Interval[] {
    const out: Interval[] = [];
    for (const i of [...list].sort((a, b) => a.start - b.start || a.end - b.end)) {
        const last = out.at(-1);
        if (last && i.start <= last.end)
            last.end = Math.max(last.end, i.end);
        else
            out.push({ ...i });
    }
    return out;
}
export function parseAvailability(text: string): {
    ok: true;
    intervals: Interval[];
} | {
    ok: false;
    error: string;
} {
    if (!text.trim())
        return { ok: true, intervals: [] };
    const parts = text.split(/[,;\n]/);
    if (parts.length > 20)
        return { ok: false, error: "At most 20 availability windows" };
    const intervals: Interval[] = [];
    for (const p of parts) {
        const m = /^\s*(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})\s*$/.exec(p);
        const start = m ? parseTime(m[1]!) : null, end = m ? parseTime(m[2]!) : null;
        if (start === null || end === null || !isValidInterval({ start, end }))
            return { ok: false, error: "Use valid HH:MM-HH:MM windows" };
        intervals.push({ start, end });
    }
    return { ok: true, intervals: normalizeIntervals(intervals) };
}
export function formatAvailability(list: Interval[]): string {
    return list.map(i => `${formatTime(i.start)}-${formatTime(i.end)}`).join(", ");
}
