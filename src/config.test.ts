import {AVAILABLE_CHECKS, parseEnabledChecks} from './config.ts';

test('parseEnabledChecks() enables all checks by default', () => {
  expect(parseEnabledChecks(undefined)).toEqual(new Set(AVAILABLE_CHECKS));
  expect(parseEnabledChecks('all')).toEqual(new Set(AVAILABLE_CHECKS));
});

test('parseEnabledChecks() accepts comma and whitespace separated checks', () => {
  expect(parseEnabledChecks('labels, merge_queue\nlock')).toEqual(new Set(['labels', 'merge_queue', 'lock']));
});

test('parseEnabledChecks() accepts none', () => {
  expect(parseEnabledChecks('none')).toEqual(new Set());
});

test('parseEnabledChecks() rejects unsupported checks', () => {
  expect(() => parseEnabledChecks('labels,unknown')).toThrow(/Unknown BACKPORTER_CHECKS value\(s\): unknown/);
});
