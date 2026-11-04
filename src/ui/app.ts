import type { EventPlan, Role, Volunteer, Shift, UnfilledSlot } from '../core/types.ts';
import { createEmptyPlan, createSamplePlan, SAMPLE_PREFIX } from '../core/sample.ts';
import { parseSaveFile, serializePlan, rosterToCsv, LIMITS } from '../core/io.ts';
import { validateAssignments, checkAssignment, buildIndex, computeLoads, explainUnfilled } from '../core/constraints.ts';
import { describeBlocker, describeStatus, describeGap } from '../core/explain.ts';
import { solve } from '../core/solver.ts';
import { parseTime, formatTime, parseAvailability, formatAvailability } from '../core/time.ts';
import { normalizeSkills } from '../core/skills.ts';
import { planStorage } from './storage.ts';
const LIMITATION_NOTES = [
  'Data stays in this browser (localStorage) and in files you export. The app sends no roster data anywhere and'
    + ' has no analytics or telemetry.',
  'The static host (for example GitHub Pages) may log standard request data such as IP address for security.',
  'Single day only: no overnight shifts and no time zones. Availability must contain the whole shift.',
  'The solver uses a bounded heuristic search and is not guaranteed optimal. Large plans can reach the search'
    + ' budget; the roster is still valid.',
  'Gap explanations are relative to the plan data, not to the real world.',
  'Very large plans may not fit in browser storage. Export JSON for a backup.',
];

const GAP_BADGES: Record<UnfilledSlot['reason'], string> = {
  'no-eligible-volunteer': 'Not enough eligible volunteers',
  'eligible-available': 'Eligible volunteers can be added',
  'blocked-by-assignments': 'Blocked by other assignments',
};

export function mountApp(root: HTMLElement, deps: {
  storage: Storage | null;
  download: (filename: string, mime: string, text: string) => void;
}): {
  destroy(): void;
} {
  const doc = root.ownerDocument;
  let message = 'Ready. Add your event details or load the synthetic sample.';
  let storageNotice = '';
  let confirming = false;
  let destroyed = false;
  let sequence = 0;
  let focusTarget = '';
  let previousPlan: EventPlan;
  const disclosureState = new Map<string, boolean>();
  function focusKey(node: Element): string {
    const group = node.closest('[data-editor-id], [data-shift-id]');
    const control = node as HTMLInputElement;
    return `${group?.getAttribute('data-editor-id') || group?.getAttribute('data-shift-id') ||
      'page'}:${control.getAttribute('data-field') || control.getAttribute('aria-label') ||
      control.textContent}`;
  }
  const store = planStorage(deps.storage, text => {
    storageNotice = text;
  });
  let plan = store.load();
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElement(tag);
    if (text !== undefined)
      node.textContent = text;
    return node;
  };
  function button(parent: HTMLElement, text: string, action: () => void) {
    const entry = el('button', text);
    entry.type = 'button';
    entry.addEventListener('click', action);
    parent.append(entry);
    return entry;
  }
  function section(parent: HTMLElement, title: string) {
    const area = el('section');
    area.id = title.toLowerCase().replaceAll(' ', '-');
    area.append(el('h2', title));
    parent.append(area);
    return area;
  }
  function notify(text: string) {
    message = text;
    render(true);
  }
  function commit(text = 'Changes saved.', preserveEditors = false) {
    const result = validateAssignments(plan);
    plan.assignments = result.valid;
    const oldIndex = buildIndex(previousPlan || plan);
    const newIndex = buildIndex(plan);
    const removalDetails = result.invalid.map(entry => {
      const volunteer = oldIndex.volunteerById.get(entry.assignment.volunteerId);
      const shift = oldIndex.shiftById.get(entry.assignment.shiftId);
      const label = shift?.label || (shift && oldIndex.roleById.get(shift.roleId)?.name) ||
        entry.assignment.shiftId;
      const time = shift ? ` ${formatTime(shift.start)}–${formatTime(shift.end)}` : '';
      const reasons = entry.blockers.map(blocker => describeBlocker(blocker, newIndex)).join('; ');
      return `${volunteer?.name || entry.assignment.volunteerId} from "${label}"${time} (${reasons})`;
    });
    const removed = result.invalid.length;
    message = removed
      ? `Removed ${removed} assignment${removed === 1 ? ' that no longer fits' : 's that no longer fit'}: `
        + `${removalDetails.join('; ')}.`
      : text;
    store.save(plan);
    if (preserveEditors) refreshRoster();
    else render(true);
  }
  // A field's native change event often runs during Tab or pointer navigation.
  // Keep those controls connected so the browser can finish that interaction.
  function refreshRoster() {
    const main = root.querySelector('main')!;
    const setup = root.querySelector<HTMLElement>('#setup')!;
    for (const id of ['schedule', 'coverage', 'workload']) root.querySelector(`#${id}`)?.remove();
    schedule(main);
    for (const id of ['schedule', 'coverage', 'workload']) {
      main.insertBefore(root.querySelector(`#${id}`)!, setup);
    }
    root.querySelector('[role=status]')!.textContent = [message, storageNotice].filter(Boolean).join(' ');
    for (const row of setup.querySelectorAll<HTMLElement>('[data-editor-id]')) {
      const itemId = row.dataset.editorId;
      const collection = row.closest<HTMLDetailsElement>('details[data-panel]')?.dataset.panel;
      const role = collection === 'Roles' ? plan.roles.find(item => item.id === itemId) : undefined;
      const volunteer = collection === 'Volunteers' ? plan.volunteers.find(item => item.id === itemId) : undefined;
      const shift = collection === 'Shifts' ? plan.shifts.find(item => item.id === itemId) : undefined;
      const legend = row.querySelector('legend');
      if (legend) legend.textContent = role?.name || volunteer?.name || shift?.label || 'Shift';
      if (volunteer) {
        const helper = row.querySelector('p');
        if (helper) helper.textContent = `Time cap: ${Math.floor(volunteer.maxMinutes / 60)} hours `
          + `${volunteer.maxMinutes % 60} minutes`;
      }
    }
    for (const option of setup.querySelectorAll<HTMLOptionElement>('select[data-field=Role] option')) {
      option.textContent = plan.roles.find(role => role.id === option.value)?.name || option.value;
    }
    const badge = root.querySelector('.badge');
    if (!plan.name.startsWith(SAMPLE_PREFIX)) badge?.remove();
    else if (!badge) {
      const sample = el('strong', 'Synthetic sample data');
      sample.className = 'badge';
      root.querySelector('header')!.insertBefore(sample, root.querySelector('.actions'));
    }
    previousPlan = structuredClone(plan);
  }
  function id(prefix: string): string {
    let value: string;
    do {
      value = `${prefix}-${++sequence}`;
    } while ([...plan.roles, ...plan.volunteers, ...plan.shifts].some(item => item.id === value));
    return value;
  }
  function field(parent: HTMLElement, label: string, value: string, apply: (value: string) => string | void,
    type = 'text') {
    const wrap = el('div');
    const input = el('input');
    input.type = type;
    input.value = value;
    if (label.includes('24-hour')) {
      input.inputMode = 'numeric';
      input.placeholder = 'HH:MM';
      input.pattern = '[0-9]{2}:[0-9]{2}';
    }
    input.setAttribute('data-field', label);
    input.id = `field-${++sequence}`;
    const lab = el('label', label);
    lab.htmlFor = input.id;
    const error = el('span');
    error.className = 'error';
    error.id = `${input.id}-error`;
    input.setAttribute('aria-describedby', error.id);
    input.setAttribute('aria-invalid', 'false');
    input.addEventListener('change', () => {
      const problem = apply(input.value);
      if (problem) {
        input.setAttribute('aria-invalid', 'true');
        error.textContent = problem;
      }
      else {
        input.setAttribute('aria-invalid', 'false');
        error.textContent = '';
        commit('Changes saved.', true);
      }
    });
    wrap.append(lab, input, error);
    parent.append(wrap);
    return input;
  }
  const nameError = (volunteer: string, max = 80, required = true) => (required &&
    !volunteer.trim()) || volunteer.trim().length > max ? `Enter ${required ? '1' : '0'}–${max} characters.` : '';
  function textField(parent: HTMLElement, label: string, value: string, set: (volunteer: string) => void,
    max = 80, required = true) {
    return field(parent, label, value, volunteer => {
      const error = nameError(volunteer, max, required);
      if (error)
        return error;
      set(volunteer.trim());
    });
  }
  function skills(parent: HTMLElement, label: string, value: string[], set: (volunteer: string[]) => void) {
    field(parent, label, value.join(', '), volunteer => {
      const result = normalizeSkills(volunteer);
      if (result.rejected.length)
        return `Invalid or excess skills: ${result.rejected.join(', ')}`;
      set(result.skills);
    });
  }
  function number(parent: HTMLElement, label: string, value: number, min: number,
    max: number, set: (volunteer: number) => void) {
    const input = field(parent, label, String(value), volunteer => {
      const total = Number(volunteer);
      if (!volunteer.trim() || !Number.isInteger(total) || total < min || total > max)
        return `Enter a whole number from ${min} to ${max}.`;
      set(total);
    }, 'number');
    input.min = String(min);
    input.max = String(max);
  }
  function roleSelect(parent: HTMLElement, label: string, value: string, set: (volunteer: string) => void) {
    const lab = el('label', label);
    const select = el('select');
    select.dataset.field = label;
    lab.append(select);
    for (const role of plan.roles) {
      const option = el('option', role.name);
      option.value = role.id;
      select.append(option);
    }
    select.value = value;
    select.addEventListener('change', () => {
      set(select.value);
      commit('Changes saved.', true);
    });
    parent.append(lab);
  }
  function editors(main: HTMLElement) {
    function panel(title: string) {
      const details = el('details');
      details.dataset.panel = title;
      details.open = !plan.volunteers.length || !plan.shifts.length || (disclosureState.get(title) ?? false);
      details.append(el('summary', title));
      details.addEventListener('toggle', () => {
        if (details.isConnected)
          disclosureState.set(title, details.open);
      });
      main.append(details);
      return details;
    }
    const event = panel('Event details');
    textField(event, 'Event name', plan.name, volunteer => {
      plan.name = volunteer;
    });
    textField(event, 'Date label', plan.dateLabel, volunteer => {
      plan.dateLabel = volunteer;
    }, 40, false);
    const roles = panel('Roles');
    for (const role of plan.roles) {
      const row = el('fieldset');
      row.dataset.editorId = role.id;
      row.append(el('legend', role.name));
      textField(row, 'Role name', role.name, volunteer => {
        role.name = volunteer;
      });
      skills(row, 'Required skills', role.requiredSkills, volunteer => {
        role.requiredSkills = volunteer;
      });
      button(row, 'Delete role', () => {
        if (plan.shifts.some(shift => shift.roleId === role.id))
          return notify('Delete the shifts using this role first.');
        const next = plan.roles[plan.roles.indexOf(role) + 1];
        focusTarget = next ? `${next.id}:Role name` : 'page:Add role';
        plan.roles = plan.roles.filter(item => item !== role);
        commit();
      });
      roles.append(row);
    }
    button(roles, 'Add role', () => {
      if (plan.roles.length >= LIMITS.roles)
        return notify('Role limit reached (50).');
      const role: Role = {
        id: id('role'), name: 'New role', requiredSkills: []
      };
      plan.roles.push(role);
      disclosureState.set('Roles', true);
      const panel = root.querySelector<HTMLDetailsElement>('details[data-panel="Roles"]');
      if (panel) panel.open = true;
      focusTarget = `${role.id}:Role name`;
      commit();
    });
    const volunteers = panel('Volunteers');
    for (const volunteer of plan.volunteers) {
      const row = el('fieldset');
      row.dataset.editorId = volunteer.id;
      row.append(el('legend', volunteer.name));
      textField(row, 'Volunteer name', volunteer.name, item => {
        volunteer.name = item;
      });
      skills(row, 'Skills (comma separated)', volunteer.skills, item => {
        volunteer.skills = item;
      });
      field(row, 'Availability (09:00-12:00, 13:00-17:00)', formatAvailability(volunteer.availability), item => {
        const parsed = parseAvailability(item);
        if (!parsed.ok)
          return parsed.error;
        volunteer.availability = parsed.intervals;
      });
      number(row, 'Maximum shifts', volunteer.maxShifts, 0, 50, item => {
        volunteer.maxShifts = item;
      });
      number(row, 'Maximum minutes', volunteer.maxMinutes, 0, 1440, item => {
        volunteer.maxMinutes = item;
      });
      row.append(el('p', `Time cap: ${Math.floor(volunteer.maxMinutes / 60)} hours ${volunteer.maxMinutes % 60} minutes`));
      button(row, 'Delete volunteer', () => {
        const next = plan.volunteers[plan.volunteers.indexOf(volunteer) + 1];
        focusTarget = next ? `${next.id}:Volunteer name` : 'page:Add volunteer';
        plan.volunteers = plan.volunteers.filter(item => item !== volunteer);
        commit();
      });
      volunteers.append(row);
    }
    button(volunteers, 'Add volunteer', () => {
      if (plan.volunteers.length >= LIMITS.volunteers)
        return notify('Volunteer limit reached (300).');
      const volunteer: Volunteer = {
        id: id('volunteer'), name: 'New volunteer', skills: [], availability: [], maxShifts: 3, maxMinutes: 360
      };
      plan.volunteers.push(volunteer);
      disclosureState.set('Volunteers', true);
      const panel = root.querySelector<HTMLDetailsElement>('details[data-panel="Volunteers"]');
      if (panel) panel.open = true;
      focusTarget = `${volunteer.id}:Volunteer name`;
      commit();
    });
    const shifts = panel('Shifts');
    for (const shift of plan.shifts) {
      const row = el('fieldset');
      row.dataset.editorId = shift.id;
      row.append(el('legend', shift.label || 'Shift'));
      roleSelect(row, 'Role', shift.roleId, volunteer => {
        shift.roleId = volunteer;
      });
      textField(row, 'Shift label', shift.label, volunteer => {
        shift.label = volunteer;
      }, 80, false);
      for (const key of ['start', 'end'] as const)
        field(row, key === 'start' ? 'Start (24-hour HH:MM)' : 'End (24-hour HH:MM, 24:00 allowed)',
          formatTime(shift[key]), volunteer => {
            const time = parseTime(volunteer);
            if (time === null || (key === 'start' ? time >= 1440 || time >= shift.end : time <= shift.start))
              return 'Use a valid same-day interval with start before end (24:00 supported as end).';
            shift[key] = time;
          });
      number(row, 'Needed', shift.needed, 1, 50, volunteer => {
        shift.needed = volunteer;
      });
      button(row, 'Delete shift', () => {
        const next = plan.shifts[plan.shifts.indexOf(shift) + 1];
        focusTarget = next ? `${next.id}:Role` : 'page:Add shift';
        plan.shifts = plan.shifts.filter(item => item !== shift);
        commit();
      });
      shifts.append(row);
    }
    button(shifts, 'Add shift', () => {
      if (!plan.roles[0])
        return notify('Add a role first.');
      if (plan.shifts.length >= LIMITS.shifts)
        return notify('Shift limit reached (300).');
      const shift: Shift = {
        id: id('shift'), roleId: plan.roles[0].id, label: 'New shift', start: 540, end: 600, needed: 1
      };
      plan.shifts.push(shift);
      disclosureState.set('Shifts', true);
      const panel = root.querySelector<HTMLDetailsElement>('details[data-panel="Shifts"]');
      if (panel) panel.open = true;
      focusTarget = `${shift.id}:Role`;
      commit();
    });
  }
  function schedule(main: HTMLElement) {
    const index = buildIndex(plan);
    const total = plan.shifts.reduce((total, shift) => total + shift.needed, 0);
    const summary = section(main, 'Coverage');
    summary.append(el('p', `${plan.assignments.length} / ${total} slots filled`));
    const filledByRole = new Map<string, number>();
    for (const assignment of plan.assignments) {
      const roleId = index.shiftById.get(assignment.shiftId)?.roleId ?? '';
      filledByRole.set(roleId, (filledByRole.get(roleId) ?? 0) + 1);
    }
    for (const role of plan.roles) {
      const needed = plan.shifts
        .filter(shift => shift.roleId === role.id)
        .reduce((sum, shift) => sum + shift.needed, 0);
      summary.append(el('p', `${role.name}: ${filledByRole.get(role.id) ?? 0} / ${needed}`));
    }
    const area = section(main, 'Schedule');
    if (!plan.shifts.length || !plan.volunteers.length)
      area.append(el('p', 'Open Setup to add volunteers and shifts, then generate a roster.'));
    const gaps = explainUnfilled(plan, plan.assignments);
    for (const shift of [...plan.shifts].sort((assignment, entry) => assignment.start - entry.start ||
      assignment.id.localeCompare(entry.id))) {
      const card = el('article');
      card.className = 'shift-card';
      card.setAttribute('data-shift-id', shift.id);
      const shiftName = shift.label || index.roleById.get(shift.roleId)?.name || shift.id;
      card.append(el('h3', `${shiftName} · ${formatTime(shift.start)}–${formatTime(shift.end)}`));
      for (const assignment of plan.assignments.filter(assignment => assignment.shiftId === shift.id)) {
        const chip = el('div');
        chip.className = 'assignment';
        chip.append(el('span', index.volunteerById.get(assignment.volunteerId)?.name ||
          assignment.volunteerId));
        // Toggle button: constant name, state in aria-pressed (styled in CSS).
        const lock = button(chip, 'Lock', () => {
          assignment.locked = !assignment.locked;
          commit('Lock updated.');
        });
        lock.dataset.field = `lock-${assignment.volunteerId}`;
        lock.setAttribute('aria-pressed', String(assignment.locked));
        const volunteerName = index.volunteerById.get(assignment.volunteerId)?.name || assignment.volunteerId;
        lock.setAttribute('aria-label', `Lock ${volunteerName} on ${shiftName}`);
        lock.title = assignment.locked ? 'Locked: kept when regenerating' : 'Not locked: Generate may replace it';
        button(chip, 'Remove', () => {
          plan.assignments = plan.assignments.filter(item => item !== assignment);
          commit('Assignment removed.');
        });
        card.append(chip);
      }
      const label = el('label', 'Add volunteer');
      const select = el('select');
      select.setAttribute('aria-label', `Add volunteer to ${shift.label || shift.id}`);
      const blank = el('option', 'Choose a volunteer');
      blank.value = '';
      select.append(blank);
      for (const volunteer of plan.volunteers) {
        const blockers = checkAssignment(plan, plan.assignments, shift.id, volunteer.id);
        const option = el('option', volunteer.name + (blockers.length ? ` — ${describeBlocker(blockers[0]!,
          index)}` : ''));
        option.value = volunteer.id;
        option.disabled = blockers.length > 0;
        select.append(option);
      }
      label.append(select);
      card.append(label);
      button(card, 'Add', () => {
        if (!select.value)
          return notify(`Choose a volunteer to add to "${shift.label ||
            index.roleById.get(shift.roleId)?.name || shift.id}".`);
        const blockers = checkAssignment(plan, plan.assignments, shift.id, select.value);
        if (blockers.length)
          return notify(blockers.map(entry => describeBlocker(entry, index)).join('; '));
        plan.assignments.push({
          shiftId: shift.id, volunteerId: select.value, locked: true
        });
        commit('Manual assignment added and locked.');
      });
      const gap = gaps.find(g => g.shiftId === shift.id);
      if (gap) {
        const details = el('details');
        card.append(el('p', GAP_BADGES[gap.reason]));
        details.append(el('summary', describeGap(gap, shift)));
        const list = el('ul');
        for (const entry of gap.blockers) {
          const name = index.volunteerById.get(entry.volunteerId)?.name || entry.volunteerId;
          const reasons = entry.blockers.map(blocker => describeBlocker(blocker, index)).join('; ');
          list.append(el('li', `${name}: ${reasons || 'Can be added now (Generate, or add manually).'}`));
        }
        if (!gap.blockers.length)
          list.append(el('li', 'No other volunteers available.'));
        details.append(list);
        card.append(details);
      }
      area.append(card);
    }
    main.insertBefore(area, summary);
    const workload = section(main, 'Workload');
    const wrap = el('div');
    wrap.className = 'table-scroll';
    const table = el('table');
    table.append(el('caption', 'Volunteer workload and hard caps'));
    const head = el('thead');
    const hr = el('tr');
    for (const title of ['Volunteer', 'Shifts', 'Minutes', 'Shift cap', 'Minute cap']) {
      const th = el('th', title);
      th.scope = 'col';
      hr.append(th);
    }
    head.append(hr);
    table.append(head);
    const body = el('tbody');
    const loads = computeLoads(plan, plan.assignments);
    for (const load of loads) {
      const volunteer = index.volunteerById.get(load.volunteerId)!;
      const tr = el('tr');
      for (const value of [volunteer.name, load.shifts, load.minutes, volunteer.maxShifts, volunteer.maxMinutes])
        tr.append(el('td', String(value)));
      body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    workload.append(wrap);
    const minutes = loads.filter(l => index.volunteerById.get(l.volunteerId)!.availability.length).map(l => l.minutes);
    const spread = minutes.length ? Math.max(...minutes) - Math.min(...minutes) : 0;
    workload.append(el('p', `Workload spread (volunteers with availability): ${spread} minutes.`));
  }
  function render(_focus = false) {
    if (destroyed)
      return;
    const active = doc.activeElement;
    const restoreKey = focusTarget || (active && root.contains(active) ? focusKey(active) : '');
    focusTarget = '';
    for (const details of root.querySelectorAll<HTMLDetailsElement>('details[data-panel]')) {
      disclosureState.set(details.dataset.panel!, details.open);
    }
    root.replaceChildren();
    const header = el('header');
    header.append(
      el('h1', 'ShiftFair'),
      el('p', 'Plan a feasible volunteer roster, with fairer workloads. Your data stays in this browser.'),
    );
    if (plan.name.startsWith(SAMPLE_PREFIX)) {
      const badge = el('strong', 'Synthetic sample data');
      badge.className = 'badge';
      header.append(badge);
    }
    const actions = el('div');
    actions.className = 'actions';
    header.append(actions);
    button(actions, 'Load sample', () => {
      plan = createSamplePlan();
      commit('Synthetic sample loaded.');
    });
    button(actions, 'New empty event', () => {
      plan = createEmptyPlan();
      commit('Empty event created.');
    });
    const slug = () => plan.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event';
    button(actions, 'Export JSON', () => deps.download(`shiftfair-${slug()}.json`,
      'application/json', serializePlan(plan)));
    button(actions, 'Export CSV', () => deps.download(`shiftfair-${slug()}-roster.csv`,
      'text/csv', rosterToCsv(plan, plan.assignments)));
    const importLabel = el('label', 'Import JSON');
    const file = el('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    importLabel.append(file);
    actions.append(importLabel);
    file.addEventListener('change', () => {
      const selected = file.files?.[0];
      if (!selected)
        return;
      if (selected.size > LIMITS.maxBytes)
        return notify(`"${selected.name}" is ${Math.ceil(selected.size / 1024)} KB; the limit is `
          + `${LIMITS.maxBytes / 1024} KB. Nothing was changed.`);
      const Reader = doc.defaultView?.FileReader;
      if (!Reader)
        return notify('File reading is unavailable.');
      const reader = new Reader();
      reader.onerror = () => notify('Import failed: could not read file. Nothing was changed.');
      reader.onload = () => {
        if (destroyed)
          return;
        const result = parseSaveFile(String(reader.result));
        if (!result.ok)
          return notify(`Import failed: ${result.errors.join('; ')}`);
        plan = result.plan;
        commit(`Import complete. ${result.warnings.join('; ')}`);
      };
      reader.readAsText(selected);
    });
    if (!confirming)
      button(actions, 'Clear saved data', () => {
        confirming = true;
        render(true);
      });
    else {
      actions.append(el('span', 'Clear this event and saved browser data?'));
      button(actions, 'Confirm clear', () => {
        store.clear();
        plan = createEmptyPlan();
        confirming = false;
        notify('Saved data cleared.');
      });
      button(actions, 'Cancel', () => {
        confirming = false;
        render(true);
      });
    }
    const nav = el('nav');
    nav.setAttribute('aria-label', 'Roster sections');
    for (const name of ['Schedule', 'Coverage', 'Workload', 'Setup']) {
      const link = el('a', name);
      link.href = `#${name.toLowerCase()}`;
      nav.append(link);
    }
    header.append(nav);
    root.append(header);
    const status = el('p', [message, storageNotice].filter(Boolean).join(' '));
    status.className = 'status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.tabIndex = -1;
    root.append(status);
    const main = el('main');
    root.append(main);
    const generator = section(main, 'Generate roster');
    button(generator, 'Generate roster', () => {
      const result = solve(plan);
      plan.assignments = result.assignments;
      focusTarget = 'schedule-heading';
      const dropped = result.droppedLocked.length;
      commit(describeStatus(result) + (dropped ? ` Dropped ${dropped} invalid locks.` : ''));
    });
    schedule(main);
    const setup = section(main, 'Setup');
    const grid = el('div');
    grid.className = 'editors';
    setup.append(grid);
    editors(grid);
    const limits = section(main, 'Privacy and limitations');
    const notes = el('ul');
    for (const note of LIMITATION_NOTES)
      notes.append(el('li', note));
    limits.append(notes);
    const heading = root.querySelector<HTMLElement>('#schedule h2');
    if (heading)
      heading.tabIndex = -1;
    if (restoreKey === 'schedule-heading')
      heading?.focus();
    else if (restoreKey) {
      const controls = [...root.querySelectorAll<HTMLElement>('input, select, button')];
      const replacement = controls.find(control => focusKey(control) === restoreKey);
      const fallback = controls.find(control => `page:${control.textContent}` === restoreKey);
      (replacement || fallback)?.focus();
    }
    previousPlan = structuredClone(plan);
  }
  render();
  return {
    destroy() {
      destroyed = true;
      root.replaceChildren();
    }
  };
}
