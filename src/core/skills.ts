export function normalizeSkill(s: string): string | null {
    const n = s.trim().toLowerCase().replace(/\s+/g, "-");
    return /^[a-z0-9][a-z0-9-]{0,29}$/.test(n) ? n : null;
}
export function normalizeSkills(input: string | string[]): {
    skills: string[];
    rejected: string[];
} {
    const rejected: string[] = [], set = new Set<string>();
    for (const s of typeof input === "string" ? input.split(",") : input) {
        const n = normalizeSkill(s);
        if (n === null)
            rejected.push(s);
        else
            set.add(n);
    }
    const all = [...set].sort();
    rejected.push(...all.slice(20));
    return { skills: all.slice(0, 20), rejected };
}
