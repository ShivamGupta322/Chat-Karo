import { describe, expect, it } from 'vitest';
import {
  describeConnectionError,
  describeJoinFailure,
  describeMessageError,
  describeOnboardError,
  describeSendError,
  AREA_TEXT,
  IDENTITY_TEXT,
  type SendError,
} from '../../src/ui/text';
import { DEV_LOCATION_TEXT, DEV_MAP_TEXT } from '../../src/geo/devLocationText';
import type { OnboardError } from '../../src/state/identity';
import type { ConnectionError, JoinFailure } from '../../src/xmpp';

const JOIN_FAILURES: JoinFailure[] = [
  'conflict',
  'not-authorized',
  'forbidden',
  'registration-required',
  'not-allowed',
  'service-unavailable',
  'not-acceptable',
  'item-not-found',
  'timeout',
  'not-connected',
  'invalid-room',
  'invalid-nick',
  'other',
];
const SEND_ERRORS: SendError[] = ['empty', 'too-long', 'not-connected', 'not-joined'];
const REASONS: ConnectionError['reason'][] = [
  'auth-failed',
  'connection-failed',
  'connection-lost',
  'error',
];
const ONBOARD_ERRORS: OnboardError[] = ['empty', 'invalid', 'taken', 'unavailable', 'failed'];
const identityStrings = (): string[] =>
  Object.values(IDENTITY_TEXT).map((v) => (typeof v === 'function' ? v('Alice_1') : v));
const CONDITIONS = [
  'item-not-found',
  'forbidden',
  'not-acceptable',
  'resource-constraint',
  'policy-violation',
  'something-else',
];

describe('describeMessageError', () => {
  it.each([
    ['item-not-found', 'the room is unavailable or locked'],
    ['forbidden', 'you are not allowed to post here'],
    ['not-acceptable', 'you are not in this room'],
    ['resource-constraint', "you're sending too fast"],
    ['policy-violation', "you're sending too fast"],
    ['something-else', 'the server rejected it'],
  ])('%s', (condition, text) => {
    expect(describeMessageError(condition)).toBe(text);
  });
});

describe('describeConnectionError', () => {
  it.each([
    ['auth-failed', "Nearby couldn't sign you in with this name."],
    ['connection-failed', "Can't reach the chat server right now. Try again in a moment."],
    ['connection-lost', 'Connection lost. Try again.'],
    ['error', 'Something went wrong. Try again.'],
  ] as const)('%s', (reason, text) => {
    expect(describeConnectionError({ reason })).toBe(text);
  });
});

describe('describeJoinFailure / describeSendError', () => {
  it.each(JOIN_FAILURES)('describes join failure %s', (reason) => {
    expect(describeJoinFailure(reason).length).toBeGreaterThan(0);
  });
  it.each(SEND_ERRORS)('describes send error %s', (error) => {
    expect(describeSendError(error).length).toBeGreaterThan(0);
  });
  it('has a text for every JoinFailure and none for removed ones', () => {
    // Compile-time exhaustive: adding or removing a JoinFailure breaks this literal until the test is updated.
    const all: Record<JoinFailure, true> = {
      conflict: true,
      'not-authorized': true,
      forbidden: true,
      'registration-required': true,
      'not-allowed': true,
      'service-unavailable': true,
      'not-acceptable': true,
      'item-not-found': true,
      timeout: true,
      'not-connected': true,
      'invalid-room': true,
      'invalid-nick': true,
      other: true,
    };
    expect(Object.keys(all).sort()).toEqual([...JOIN_FAILURES].sort());
  });
  it('has the access-recovery texts', () => {
    expect(describeJoinFailure('not-allowed')).toBe("You can't open this room.");
    expect(AREA_TEXT.accessDenied).toBe("Nearby couldn't let you into this area's chat.");
    expect(AREA_TEXT.accessRetry).toBe('Try again');
  });
  it('uses the plan wording for a few key strings', () => {
    expect(describeJoinFailure('conflict')).toBe('That name is already taken in this room.');
    expect(describeSendError('too-long')).toBe('That message is too long (max 2000 characters).');
    expect(describeJoinFailure('invalid-room')).toBe(
      'Room names use lowercase letters, numbers, dots, dashes or underscores.',
    );
  });
});

describe('identity text', () => {
  it('maps every onboarding error to its exact copy', () => {
    expect(describeOnboardError('empty')).toBe('Enter a name.');
    expect(describeOnboardError('invalid')).toBe(
      'Names are 2–20 characters: letters, numbers, - or _, starting with a letter or number.',
    );
    expect(describeOnboardError('taken')).toBe('That name is taken. Try another.');
    expect(describeOnboardError('unavailable')).toBe(
      "Nearby can't create names right now. Try again in a few seconds.",
    );
    expect(describeOnboardError('failed')).toBe('Something went wrong. Try again.');
  });

  it('has the exact device note, not-remembered and confirm copy', () => {
    expect(IDENTITY_TEXT.deviceNote).toBe(
      "Nearby gives you a name on this device only. There's no email or password. If you clear this browser's data or switch devices, you'll start again with a new name.",
    );
    expect(IDENTITY_TEXT.notRemembered).toBe("This name won't be remembered on this device.");
    expect(IDENTITY_TEXT.confirmTitle).toBe('Start over with a new name?');
    expect(IDENTITY_TEXT.confirmBody).toBe("Your current name can't be recovered.");
    expect(IDENTITY_TEXT.creating).toBe('Creating…');
    expect(IDENTITY_TEXT.continueAs('Alice_1')).toBe('Continue as Alice_1');
    expect(IDENTITY_TEXT.connecting('Alice_1')).toBe('Signing you in as Alice_1…');
  });
});

describe('no protocol jargon in user-facing text', () => {
  // 'password' is allowed: the device note says there is no email or password.
  const JARGON = /\b(JID|XMPP|MUC|occupant|token|credential|localpart)\b/i;
  const all: string[] = [
    ...REASONS.map((reason) => describeConnectionError({ reason })),
    ...JOIN_FAILURES.map(describeJoinFailure),
    ...SEND_ERRORS.map(describeSendError),
    ...CONDITIONS.map(describeMessageError),
    ...ONBOARD_ERRORS.map(describeOnboardError),
    ...identityStrings(),
  ];
  it.each(all)('%s', (text) => {
    expect(text).not.toMatch(JARGON);
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('area and dev-location text', () => {
  const JARGON = /geohash|jid|muc|cell|coordinate/i;
  const strings = (o: Record<string, unknown>): string[] =>
    Object.values(o).map((v) => (typeof v === 'function' ? (v as (s: string) => string)('u4pruyd') : String(v)));

  it.each(strings(AREA_TEXT))('AREA_TEXT %s has no jargon', (text) => {
    expect(text).not.toMatch(JARGON);
    expect(text.length).toBeGreaterThan(0);
  });

  it.each(strings(DEV_LOCATION_TEXT))('DEV_LOCATION_TEXT %s has no jargon', (text) => {
    expect(text).not.toMatch(JARGON);
    expect(text.length).toBeGreaterThan(0);
  });

  it.each(
    strings({ label: DEV_MAP_TEXT.label, hint: DEV_MAP_TEXT.hint, loading: DEV_MAP_TEXT.loading, failed: DEV_MAP_TEXT.failed }),
  )('DEV_MAP_TEXT %s has no jargon', (text) => {
    expect(text).not.toMatch(/geohash|jid|muc|cell|coordinate/i);
    expect(text.length).toBeGreaterThan(0);
  });

  it('has the left-room line', () => {
    expect(AREA_TEXT.left).toBe('You left the room');
  });

  it('formats the area label and joining message', () => {
    expect(AREA_TEXT.areaLabel('u4pruyd')).toBe('Area u4pruyd');
    expect(AREA_TEXT.joining('Area u4pruyd')).toBe('Joining Area u4pruyd…');
  });

  it('has the locate copy', () => {
    expect(AREA_TEXT.assigning('Area u4pruyd')).toBe('Finding the chat for Area u4pruyd…');
    expect(AREA_TEXT.retryAssign).toBe('Find my area chat');
    const texts = [
      AREA_TEXT.locateUnavailable,
      AREA_TEXT.locateOffline,
      AREA_TEXT.locateIdentityInvalid,
      AREA_TEXT.locateBadResponse,
    ];
    expect(new Set(texts).size).toBe(texts.length);
  });
});
