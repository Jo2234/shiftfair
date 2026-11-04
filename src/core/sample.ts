import type { EventPlan, Interval, Shift, Volunteer } from './types.ts';
import { parseTime } from './time.ts';

// Built-in demo data. Every name is invented for this sample; the event, people
// and numbers are synthetic and describe no real organisation.
export const SAMPLE_PREFIX = 'Sample: ';

export function createEmptyPlan(): EventPlan {
    return { name: 'Untitled event', dateLabel: '', roles: [], volunteers: [], shifts: [], assignments: [] };
}

function minutes(text: string): number {
    const value = parseTime(text);
    if (value === null) {
        throw new Error(`Invalid sample time ${text}`);
    }
    return value;
}

function windows(...ranges: [string, string][]): Interval[] {
    return ranges.map(([start, end]) => ({ start: minutes(start), end: minutes(end) }));
}

function volunteer(
    id: string,
    name: string,
    skills: string[],
    availability: Interval[],
    maxShifts: number,
    maxMinutes: number,
): Volunteer {
    return { id, name, skills: [...skills].sort(), availability, maxShifts, maxMinutes };
}

function shift(id: string, roleId: string, label: string, start: string, end: string, needed: number): Shift {
    return { id, roleId, label, start: minutes(start), end: minutes(end), needed };
}

// Designed so that Generate gives a partial roster: the afternoon first-aid
// station needs two people but only one first-aider is available then (a
// genuine shortage in the data), while multi-person shifts such as the games
// corner fill, and other gaps show skill, availability, overlap and limit
// blockers.
export function createSamplePlan(): EventPlan {
    return {
        name: 'Sample: Campus Spring Fair (synthetic data)',
        dateLabel: 'Synthetic sample day',
        roles: [
            { id: 'welcome', name: 'Welcome', requiredSkills: [] },
            { id: 'tickets', name: 'Tickets', requiredSkills: ['cash'] },
            { id: 'stage', name: 'Stage crew', requiredSkills: ['sound'] },
            { id: 'games', name: 'Games', requiredSkills: [] },
            { id: 'aid', name: 'First aid', requiredSkills: ['first-aid'] },
        ],
        volunteers: [
            volunteer('v01', 'Avery Chen', ['first-aid', 'cash'], windows(['08:00', '18:00']), 3, 360),
            volunteer('v02', 'Sam Okafor', ['sound'], windows(['09:00', '16:00']), 2, 240),
            volunteer('v03', 'Mila Ortiz', ['cash'], windows(['08:00', '12:00'], ['13:00', '18:00']), 3, 300),
            volunteer('v04', 'Rowan Patel', [], windows(['08:00', '14:00']), 2, 240),
            volunteer('v05', 'Ellis Kim', ['sound', 'cash'], windows(['12:00', '18:00']), 2, 240),
            volunteer('v06', 'Noor Rivera', ['first-aid'], windows(['08:00', '13:00']), 2, 240),
            volunteer('v07', 'Casey Lin', [], windows(['10:00', '18:00']), 3, 360),
            volunteer('v08', 'Sage Mensah', ['cash'], windows(['08:00', '11:00']), 1, 180),
            volunteer('v09', 'Robin Park', ['sound'], windows(['09:00', '18:00']), 2, 300),
            volunteer('v10', 'Jamie Silva', [], windows(['08:00', '18:00']), 4, 480),
            volunteer('v11', 'Alex Reed', [], windows(['13:00', '18:00']), 2, 240),
            volunteer('v12', 'Taylor Das', [], windows(['08:00', '12:00']), 2, 240),
        ],
        shifts: [
            shift('s01', 'welcome', 'Welcome desk (morning)', '08:00', '10:00', 2),
            shift('s02', 'tickets', 'Ticket booth (morning)', '09:00', '11:00', 2),
            shift('s03', 'stage', 'Stage setup', '09:30', '11:30', 2),
            shift('s04', 'games', 'Games corner (morning)', '10:00', '12:00', 3),
            shift('s05', 'welcome', 'Welcome desk (midday)', '11:00', '13:00', 2),
            shift('s06', 'tickets', 'Ticket booth (afternoon)', '12:00', '14:00', 2),
            shift('s07', 'stage', 'Stage show', '13:00', '15:00', 2),
            shift('s08', 'games', 'Games corner (afternoon)', '13:00', '15:00', 2),
            shift('s09', 'aid', 'First aid station', '14:00', '17:00', 2),
            shift('s10', 'welcome', 'Pack-down', '16:00', '18:00', 3),
        ],
        assignments: [],
    };
}
