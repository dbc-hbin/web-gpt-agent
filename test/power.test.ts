/**
 * The one rule in `power.ts` that can be wrong: the hold is reference-counted.
 *
 * `prevent-app-suspension` is a single OS-level blocker, but the reasons to hold it arrive
 * independently — a work starting, a second work recovering, a command still draining after
 * a pause. Releasing on the first of those to finish would let the Mac idle out while the
 * others are still running, which is exactly the failure the blocker exists to prevent. So
 * the counting, not the Electron call, is what this asserts.
 */

import { expect, it, vi } from 'vitest';
import { powerHeld, powerHolders, resetPowerForTests, setPowerHolder, initPowerManagement } from '../src/main/power.js';

function target() {
  return { start: vi.fn(() => 7), stop: vi.fn(), isStarted: vi.fn(() => true) };
}

it('holds one blocker until the last holder releases', () => {
  resetPowerForTests();
  const blocker = target();
  initPowerManagement(blocker);
  setPowerHolder('work:a', true);
  setPowerHolder('work:b', true);
  expect(blocker.start).toHaveBeenCalledTimes(1);
  expect(powerHolders()).toEqual(['work:a', 'work:b']);
  setPowerHolder('work:a', false);
  expect(powerHeld()).toBe(true);
  expect(blocker.stop).not.toHaveBeenCalled();
  setPowerHolder('work:b', false);
  expect(powerHeld()).toBe(false);
  expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(7);
});

it('is idempotent per holder and releases only what it started', () => {
  resetPowerForTests();
  const blocker = target();
  initPowerManagement(blocker);
  setPowerHolder('work:a', true);
  setPowerHolder('work:a', true);
  expect(blocker.start).toHaveBeenCalledTimes(1);
  // Releasing a holder that never acquired anything must not stop the live blocker.
  setPowerHolder('work:never', false);
  expect(blocker.stop).not.toHaveBeenCalled();
  setPowerHolder('work:a', false);
  setPowerHolder('work:a', false);
  expect(blocker.stop).toHaveBeenCalledTimes(1);
});

it('reports a refused blocker instead of failing the work that asked for it', () => {
  resetPowerForTests();
  const warn = vi.fn();
  initPowerManagement({ start: () => { throw new Error('denied'); }, stop: () => undefined, isStarted: () => false }, warn);
  setPowerHolder('work:a', true);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('denied'));
  // The intent is still recorded, so a later release does not throw on a blocker that
  // never existed.
  expect(powerHeld()).toBe(true);
  setPowerHolder('work:a', false);
  expect(powerHeld()).toBe(false);
});
