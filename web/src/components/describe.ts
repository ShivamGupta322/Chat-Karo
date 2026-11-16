import type { ConnectionError, JoinFailure } from '../xmpp';

export function describeConnectionError(error: ConnectionError): string {
  switch (error.reason) {
    case 'auth-failed':
      return 'Wrong JID or password';
    case 'connection-failed':
      return "Can't reach the XMPP server. Is the Docker stack up?";
    case 'connection-lost':
      return 'Connection lost. Please log in again.';
    case 'error':
      return 'Something went wrong with the connection';
  }
}

const JOIN_FAILURES = {
  conflict: 'That nickname is taken',
  'not-authorized': 'This room needs a password',
  forbidden: 'You are not allowed to join this room',
  'registration-required': 'This room is members-only',
  'service-unavailable': 'The room is full or unavailable',
  'not-acceptable': 'The room does not accept that nickname',
  'item-not-found': 'That room does not exist',
  timeout: 'The room did not answer in time',
  'room-config-failed': 'The room was created but could not be configured',
  'not-connected': 'You are not connected',
  'invalid-room': 'That is not a valid room address',
  'invalid-nick': 'That is not a valid nickname (1-32 characters)',
  other: 'Could not join the room',
} satisfies Record<JoinFailure, string>;

/** Short reason for a rejected message. The server's own <text> is never rendered. */
export function describeMessageError(condition: string): string {
  switch (condition) {
    case 'item-not-found':
      return 'the room is unavailable or locked';
    case 'forbidden':
      return 'you are not allowed to post here';
    case 'not-acceptable':
      return 'you are not in this room';
    case 'resource-constraint':
    case 'policy-violation':
      return "you're sending too fast";
    default:
      return 'the server rejected it';
  }
}

export function describeJoinFailure(reason: JoinFailure): string {
  return JOIN_FAILURES[reason];
}
