import { describe, expect, it } from 'vitest';
import {
  describeAddressError,
  describeConnectionError,
  describeJoinFailure,
  describeMessageError,
  describeSendError,
  AREA_TEXT,
  type AddressError,
  type SendError,
} from '../../src/ui/text';
import { DEV_LOCATION_TEXT, DEV_MAP_TEXT } from '../../src/geo/devLocationText';
import type { ConnectionError, JoinFailure } from '../../src/xmpp';

const JOIN_FAILURES: JoinFailure[] = [
  'conflict',
  'not-authorized',
  'forbidden',
  'registration-required',
  'service-unavailable',
  'not-acceptable',
  'item-not-found',
  'timeout',
  'room-config-failed',
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
const ADDRESS_ERRORS: AddressError[] = ['empty', 'invalid', 'wrong-domain'];
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
    ['auth-failed', 'Wrong username or password.'],
    ['connection-failed', "Can't reach the chat server. Check that it's running and try again."],
    ['connection-lost', 'Connection lost. Please sign in again.'],
    ['error', 'Something went wrong. Please sign in again.'],
  ] as const)('%s', (reason, text) => {
    expect(describeConnectionError({ reason })).toBe(text);
  });
});

describe('describeJoinFailure / describeSendError / describeAddressError', () => {
  it.each(JOIN_FAILURES)('describes join failure %s', (reason) => {
    expect(describeJoinFailure(reason).length).toBeGreaterThan(0);
  });
  it.each(SEND_ERRORS)('describes send error %s', (error) => {
    expect(describeSendError(error).length).toBeGreaterThan(0);
  });
  it('uses the plan wording for a few key strings', () => {
    expect(describeJoinFailure('conflict')).toBe('That name is already taken in this room.');
    expect(describeSendError('too-long')).toBe('That message is too long (max 2000 characters).');
    expect(describeAddressError('account', 'wrong-domain', 'x.test')).toBe(
      'Use an account on x.test.',
    );
    expect(describeAddressError('room', 'invalid', 'm.test')).toBe(
      describeJoinFailure('invalid-room'),
    );
  });
});

describe('no protocol jargon in user-facing text', () => {
  const JARGON = /\b(JID|XMPP|MUC|occupant)/i;
  const all: string[] = [
    ...REASONS.map((reason) => describeConnectionError({ reason })),
    ...JOIN_FAILURES.map(describeJoinFailure),
    ...SEND_ERRORS.map(describeSendError),
    ...CONDITIONS.map(describeMessageError),
    ...ADDRESS_ERRORS.flatMap((e) => [
      describeAddressError('account', e, 'chaterl.localhost'),
      describeAddressError('room', e, 'muc.chaterl.localhost'),
    ]),
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
});
