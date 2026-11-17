import { MAX_MESSAGE_LENGTH, type ConnectionError, type JoinFailure, type SendResult } from '../xmpp';

export type SendError = Extract<SendResult, { ok: false }>['error'];
export type AddressKind = 'account' | 'room';
export type AddressError = 'empty' | 'invalid' | 'wrong-domain';

export function describeConnectionError(error: ConnectionError): string {
  switch (error.reason) {
    case 'auth-failed':
      return 'Wrong username or password.';
    case 'connection-failed':
      return "Can't reach the chat server. Check that it's running and try again.";
    case 'connection-lost':
      return 'Connection lost. Please sign in again.';
    case 'error':
      return 'Something went wrong. Please sign in again.';
  }
}

const INVALID_ROOM = 'Room names use lowercase letters, numbers, dots, dashes or underscores.';

const JOIN_FAILURES = {
  conflict: 'That name is already taken in this room.',
  'not-authorized': 'This room needs a password.',
  forbidden: "You're not allowed to join this room.",
  'registration-required': 'This room is invite-only.',
  'service-unavailable': 'This room is full or unavailable.',
  'not-acceptable': "This room doesn't accept that name.",
  'item-not-found': "That room doesn't exist.",
  timeout: "The room didn't respond. Try again.",
  'room-config-failed': "The room couldn't be set up. Try again.",
  'not-connected': "You're offline.",
  'invalid-room': INVALID_ROOM,
  'invalid-nick': 'Names must be 1–32 characters.',
  other: "Couldn't join the room.",
} satisfies Record<JoinFailure, string>;

const SEND_ERRORS = {
  empty: 'Type a message first.',
  'too-long': `That message is too long (max ${MAX_MESSAGE_LENGTH} characters).`,
  'not-connected': "You're offline.",
  'not-joined': 'Join a room first.',
} satisfies Record<SendError, string>;

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

export function describeSendError(error: SendError): string {
  return SEND_ERRORS[error];
}

export function describeAddressError(
  kind: AddressKind,
  error: AddressError,
  domain: string,
): string {
  if (kind === 'account') {
    switch (error) {
      case 'empty':
        return 'Enter your username.';
      case 'invalid':
        return 'Usernames use letters, numbers, dots, dashes or underscores.';
      case 'wrong-domain':
        return `Use an account on ${domain}.`;
    }
  }
  switch (error) {
    case 'empty':
      return 'Enter a room name.';
    case 'invalid':
      return INVALID_ROOM;
    case 'wrong-domain':
      return "That room isn't on this server.";
  }
}
