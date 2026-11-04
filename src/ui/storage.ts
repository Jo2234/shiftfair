import { parseSaveFile, serializePlan } from '../core/io.ts';
import { createEmptyPlan } from '../core/sample.ts';
import type { EventPlan } from '../core/types.ts';
export const STORAGE_KEY = 'shiftfair:plan:v1';
export function planStorage(storage: Storage | null, notice: (text: string) => void) {
  return {
    load(): EventPlan {
      try {
        if (!storage) {
          notice('Browser storage unavailable; changes stay in memory.');
          return createEmptyPlan();
        }
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw)
          return createEmptyPlan();
        const result = parseSaveFile(raw);
        if (result.ok)
          return result.plan;
        notice(`Saved data could not be loaded: ${result.errors.join('; ')}`);
      }
      catch {
        notice('Browser storage unavailable; changes stay in memory.');
      }
      return createEmptyPlan();
    },
    save(plan: EventPlan) {
      try {
        if (storage)
          storage.setItem(STORAGE_KEY, serializePlan(plan));
        else
          notice('Browser storage unavailable; changes stay in memory.');
      }
      catch {
        notice('Could not save to browser storage (it may be full or disabled); changes stay in memory. Use Export JSON to keep a copy.');
      }
    },
    clear() {
      try {
        storage?.removeItem(STORAGE_KEY);
      }
      catch {
        notice('Could not clear browser storage.');
      }
    },
  };
}
