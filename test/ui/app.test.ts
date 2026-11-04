import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountApp } from '../../src/ui/app.ts';
import { STORAGE_KEY } from '../../src/ui/storage.ts';
import { createSamplePlan } from '../../src/core/sample.ts';
import { solve } from '../../src/core/solver.ts';
import { describeStatus, describeBlocker, describeGap } from '../../src/core/explain.ts';
import { checkAssignment, buildIndex, explainUnfilled } from '../../src/core/constraints.ts';
import { serializePlan, LIMITS } from '../../src/core/io.ts';
import type { EventPlan } from '../../src/core/types.ts';
class MemoryStorage implements Storage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}
function setup(plan?: EventPlan, storage: Storage = new MemoryStorage()) {
  if (plan)
    storage.setItem(STORAGE_KEY, serializePlan(plan));
  const dom = new JSDOM('<!doctype html><div id="app"></div>');
  const root = dom.window.document.getElementById('app')!;
  const downloads: string[] = [];
  const app = mountApp(root, {
    storage, download: (_f, _m, text) => downloads.push(text)
  });
  const click = (text: string, parent: ParentNode = root) => {
    const b = [...parent.querySelectorAll('button')].find(b => b.textContent === text);
    assert.ok(b, `Button ${text}`);
    b.click();
  };
  return {
    dom, root, storage, click, downloads, cleanup() {
      app.destroy();
      dom.window.close();
    }
  };
}
function persisted(storage: Storage): EventPlan {
  const raw = storage.getItem(STORAGE_KEY);
  assert.ok(raw);
  return (JSON.parse(raw) as {
    plan: EventPlan;
  }).plan;
}
const basic = (): EventPlan => ({
  name: 'Tiny event', dateLabel: '', roles: [{
    id: 'r', name: 'Welcome', requiredSkills: []
  }], volunteers: [{
    id: 'v', name: 'A Person', skills: [], availability: [{
      start: 540, end: 720
    }], maxMinutes: 300, maxShifts: 3
  }, {
    id: 'blocked', name: 'Unavailable Person', skills: [], availability: [], maxMinutes: 300, maxShifts: 3
  }], shifts: [{
    id: 's', roleId: 'r', label: 'Morning', start: 540, end: 600, needed: 1
  }], assignments: []
});
test('sample generate status, coverage, explanations and blocked choices match core', () => {
  const t = setup();
  try {
    t.click('Load sample');
    assert.match(t.root.textContent!, /Synthetic sample data/);
    t.click('Generate roster');
    const sample = createSamplePlan();
    const result = solve(sample);
    assert.ok(t.root.querySelector('[role=status]')!.textContent!.includes(describeStatus(result)));
    assert.ok(t.root.textContent!.includes(`${result.filledSlots} / ${result.totalSlots} slots filled`));
    for (const gap of explainUnfilled(sample, result.assignments))
      for (const entry of gap.blockers)
        for (const blocker of entry.blockers)
          assert.ok(t.root.querySelector(`[data-shift-id="${gap.shiftId}"] details`)!.textContent!.includes(describeBlocker(blocker,
            buildIndex(sample))));
    assert.ok(t.root.querySelector('option:disabled'));
  }
  finally {
    t.cleanup();
  }
});
test('manual eligible add locks, regenerate preserves, lock toggles and removal works', () => {
  const t = setup(basic());
  try {
    const select = t.root.querySelector('.shift-card select') as HTMLSelectElement;
    assert.ok((select.querySelector('option[value=blocked]') as HTMLOptionElement).disabled);
    select.value = 'v';
    select.dispatchEvent(new t.dom.window.Event('change'));
    t.click('Add');
    assert.equal(t.root.querySelector('button[aria-pressed]')!.getAttribute('aria-pressed'), 'true');
    t.click('Generate roster');
    assert.equal(persisted(t.storage).assignments[0]!.locked, true);
    t.click('Lock');
    assert.equal(t.root.querySelector('button[aria-pressed]')!.getAttribute('aria-pressed'), 'false');
    t.click('Remove');
    assert.equal(persisted(t.storage).assignments.length, 0);
  }
  finally {
    t.cleanup();
  }
});
test('manual click revalidates even if a blocked option is selected programmatically', () => {
  const t = setup(basic());
  try {
    (t.root.querySelector('.shift-card select') as HTMLSelectElement).value = 'blocked';
    t.click('Add');
    assert.equal(persisted(t.storage).assignments.length, 0);
    assert.match(t.root.querySelector('[role=status]')!.textContent!, /available/i);
  }
  finally {
    t.cleanup();
  }
});
test('volunteer markup is text, availability edit invalidates assignment and shows notice', () => {
  const p = basic();
  p.volunteers[0]!.name = '<img src=x onerror=alert(1)>';
  p.assignments = [{
    shiftId: 's', volunteerId: 'v', locked: true
  }];
  const t = setup(p);
  try {
    assert.equal(t.root.querySelector('img'), null);
    assert.ok(t.root.textContent!.includes(p.volunteers[0]!.name));
    const label = [...t.root.querySelectorAll('label')].find(l => l.textContent!.startsWith('Availability'))!;
    const input = t.root.querySelector(`#${label.htmlFor}`) as HTMLInputElement;
    input.value = '13:00-14:00';
    input.dispatchEvent(new t.dom.window.Event('change'));
    assert.equal(persisted(t.storage).assignments.length, 0);
    assert.match(t.root.querySelector('[role=status]')!.textContent!, /Removed 1 assignment/);
    assert.ok(t.root.querySelector('[role=status]')!.textContent!.includes(p.volunteers[0]!.name));
    assert.match(t.root.querySelector('[role=status]')!.textContent!, /Morning/);
  }
  finally {
    t.cleanup();
  }
});
test('invalid edits show linked error and do not commit', () => {
  const t = setup(basic());
  try {
    const label = [...t.root.querySelectorAll('label')].find(l => l.textContent === 'Event name')!;
    const input = t.root.querySelector(`#${label.htmlFor}`) as HTMLInputElement;
    input.value = '';
    input.dispatchEvent(new t.dom.window.Event('change'));
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.ok(t.root.querySelector(`#${input.getAttribute('aria-describedby')}`)!.textContent);
    assert.equal(persisted(t.storage).name, 'Tiny event');
  }
  finally {
    t.cleanup();
  }
});
test('malformed file import is transactional; valid import and downloads work', async () => {
  const t = setup(basic());
  try {
    async function upload(text: string) {
      const input = t.root.querySelector('input[type=file]') as HTMLInputElement;
      Object.defineProperty(input, 'files', {
        configurable: true, value: [new t.dom.window.File([text], 'plan.json', {
          type: 'application/json'
        })]
      });
      const status = t.root.querySelector('[role=status]')!;
      const before = status.textContent;
      input.dispatchEvent(new t.dom.window.Event('change'));
      // FileReader is asynchronous: wait (bounded, 3 s) for the status to change.
      for (let attempt = 0; attempt < 150 && status.textContent === before; attempt++)
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    await upload('{oops');
    assert.match(t.root.querySelector('[role=status]')!.textContent!, /Import failed/);
    assert.equal(persisted(t.storage).name, 'Tiny event');
    const p = basic();
    p.name = 'Imported';
    await upload(serializePlan(p));
    assert.equal(persisted(t.storage).name, 'Imported');
    t.click('Export JSON');
    t.click('Export CSV');
    assert.equal(t.downloads.length, 2);
    assert.match(t.downloads[0]!, /Imported/);
  }
  finally {
    t.cleanup();
  }
});
test('clear requires confirmation, cancel keeps data, confirm removes saved key', () => {
  const t = setup(basic());
  try {
    t.click('Clear saved data');
    assert.equal(persisted(t.storage).name, 'Tiny event');
    t.click('Cancel');
    assert.equal(persisted(t.storage).name, 'Tiny event');
    t.click('Clear saved data');
    t.click('Confirm clear');
    assert.equal(t.storage.getItem(STORAGE_KEY), null);
    assert.equal((t.root.querySelector('input') as HTMLInputElement).type, 'file');
    assert.match(t.root.textContent!, /0 \/ 0 slots filled/);
  }
  finally {
    t.cleanup();
  }
});
test('throwing storage and malformed saved data produce notices without crashing', () => {
  const storage = new MemoryStorage();
  storage.getItem = () => {
    throw new Error('disabled');
  };
  storage.setItem = () => {
    throw new Error('quota');
  };
  const t = setup(undefined, storage);
  try {
    assert.match(t.root.textContent!, /storage unavailable/);
    t.click('Load sample');
    assert.match(t.root.textContent!, /Could not save/);
  }
  finally {
    t.cleanup();
  }
  const bad = new MemoryStorage();
  bad.setItem(STORAGE_KEY, '{');
  const u = setup(undefined, bad);
  try {
    assert.match(u.root.textContent!, /could not be loaded/);
  }
  finally {
    u.cleanup();
  }
});
test('used role deletion is refused', () => {
  const t = setup(basic());
  try {
    t.click('Delete role');
    assert.match(t.root.querySelector('[role=status]')!.textContent!, /Delete the shifts/);
    assert.equal(persisted(t.storage).roles.length, 1);
  }
  finally {
    t.cleanup();
  }
});
function inputByLabel(t: ReturnType<typeof setup>, label: string): HTMLInputElement {
  const element = [...t.root.querySelectorAll('label')].find(item => item.textContent === label);
  assert.ok(element, label);
  return t.root.querySelector(`#${element.htmlFor}`)!;
}
test('focus, schedule-first layout, disclosure state and privacy', () => {
  const t = setup(basic());
  try {
    const details = t.root.querySelector<HTMLDetailsElement>('details[data-panel="Volunteers"]')!;
    details.open = true;
    const input = inputByLabel(t, 'Volunteer name');
    input.focus();
    input.value = 'Updated Person';
    input.dispatchEvent(new t.dom.window.Event('change'));
    assert.equal(t.dom.window.document.activeElement, inputByLabel(t, 'Volunteer name'));
    assert.equal(t.root.querySelector<HTMLDetailsElement>('details[data-panel="Volunteers"]')!.open, true);
    const sections = [...t.root.querySelectorAll('section')];
    assert.ok(sections.indexOf(t.root.querySelector('#schedule')!) < sections.indexOf(t.root.querySelector('#setup')!));
    assert.match(t.root.textContent!, /no analytics or telemetry/);
    assert.match(t.root.textContent!, /IP address/);
    assert.match(t.root.textContent!, /no overnight shifts and no time zones/);
    t.click('Generate roster');
    assert.equal(t.dom.window.document.activeElement, t.root.querySelector('#schedule h2'));
  }
  finally {
    t.cleanup();
  }
});
test('24:00 end commits and displays while invalid endpoints do not commit', () => {
  const t = setup(basic());
  try {
    let end = inputByLabel(t, 'End (24-hour HH:MM, 24:00 allowed)');
    assert.equal(end.type, 'text');
    assert.equal(end.inputMode, 'numeric');
    end.value = '24:00';
    end.dispatchEvent(new t.dom.window.Event('change'));
    assert.equal(persisted(t.storage).shifts[0]!.end, 1440);
    assert.match(t.root.querySelector('.shift-card h3')!.textContent!, /24:00/);
    end = inputByLabel(t, 'End (24-hour HH:MM, 24:00 allowed)');
    end.value = '24:30';
    end.dispatchEvent(new t.dom.window.Event('change'));
    assert.equal(end.getAttribute('aria-invalid'), 'true');
    const start = inputByLabel(t, 'Start (24-hour HH:MM)');
    start.value = '24:00';
    start.dispatchEvent(new t.dom.window.Event('change'));
    assert.equal(start.getAttribute('aria-invalid'), 'true');
    assert.equal(persisted(t.storage).shifts[0]!.start, 540);
    assert.equal(persisted(t.storage).shifts[0]!.end, 1440);
  }
  finally {
    t.cleanup();
  }
});
test('oversize file rejected before constructing FileReader and keeps plan', () => {
  const t = setup(basic());
  try {
    let readerCalls = 0;
    Object.defineProperty(t.dom.window, 'FileReader', {
      value: class {
        constructor() {
          readerCalls++;
        }
      }
    });
    const file = new t.dom.window.File(['small'], 'big.json');
    Object.defineProperty(file, 'size', {
      value: LIMITS.maxBytes + 1
    });
    const input = t.root.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', {
      value: [file]
    });
    input.dispatchEvent(new t.dom.window.Event('change'));
    assert.equal(readerCalls, 0);
    assert.equal(persisted(t.storage).name, 'Tiny event');
    assert.match(t.root.querySelector('[role=status]')!.textContent!, new RegExp(`big\\.json.*limit is ${LIMITS.maxBytes / 1024} KB.*Nothing was changed`));
  }
  finally {
    t.cleanup();
  }
});
test('empty add is readable and lock names and state toggle', () => {
  const t = setup(basic());
  try {
    t.click('Add');
    assert.equal(t.root.querySelector('[role=status]')!.textContent, 'Choose a volunteer to add to "Morning".');
    t.root.querySelector<HTMLSelectElement>('.shift-card select')!.value = 'v';
    t.click('Add');
    let lock = t.root.querySelector('button[aria-pressed]')!;
    // Toggle pattern: constant accessible name containing the visible text; state via aria-pressed.
    assert.equal(lock.textContent, 'Lock');
    assert.equal(lock.getAttribute('aria-pressed'), 'true');
    assert.equal(lock.getAttribute('aria-label'), 'Lock A Person on Morning');
    t.click('Lock');
    lock = t.root.querySelector('button[aria-pressed]')!;
    assert.equal(lock.textContent, 'Lock');
    assert.equal(lock.getAttribute('aria-pressed'), 'false');
    assert.equal(lock.getAttribute('aria-label'), 'Lock A Person on Morning');
  }
  finally {
    t.cleanup();
  }
});
test('sample gap summaries come directly from core', () => {
  const plan = createSamplePlan();
  const result = solve(plan);
  plan.assignments = result.assignments;
  const t = setup(plan);
  try {
    for (const gap of result.unfilled) {
      const shift = plan.shifts.find(item => item.id === gap.shiftId)!;
      assert.equal(t.root.querySelector(`[data-shift-id="${shift.id}"] summary`)!.textContent,
        describeGap(gap, shift));
    }
  }
  finally {
    t.cleanup();
  }
});

test('before generating, gaps report eligible volunteers who can be added now, not conflicts', () => {
  const plan = createSamplePlan();
  const t = setup(plan);
  try {
    const gaps = explainUnfilled(plan, []);
    const open = gaps.find(gap => gap.reason === 'eligible-available')!;
    assert.ok(open, 'sample has an unassigned shift with eligible volunteers');
    const shift = plan.shifts.find(item => item.id === open.shiftId)!;
    const card = t.root.querySelector(`[data-shift-id="${shift.id}"]`)!;
    assert.equal(card.querySelector('summary')!.textContent, describeGap(open, shift));
    assert.match(card.textContent!, /Eligible volunteers can be added/);
    assert.doesNotMatch(card.textContent!, /Blocked by other assignments/);
    assert.match(describeGap(open, shift), /can be added now and 0 blocked by other assignments/);
  }
  finally {
    t.cleanup();
  }
});
