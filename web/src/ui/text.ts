import type { OnboardError } from '../state/identity';
import { MAX_MESSAGE_LENGTH, type ConnectionError, type JoinFailure, type SendResult } from '../xmpp';

export type SendError = Extract<SendResult, { ok: false }>['error'];

export function describeConnectionError(error: ConnectionError): string {
  switch (error.reason) {
    case 'auth-failed':
      return "Nearby couldn't sign you in with this name.";
    case 'connection-failed':
      return "Can't reach the chat server right now. Try again in a moment.";
    case 'connection-lost':
      return 'Connection lost. Try again.';
    case 'error':
      return 'Something went wrong. Try again.';
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

export const IDENTITY_TEXT = {
  tagline: 'Chat with people around you',
  heading: 'Pick a name',
  nicknameLabel: 'Your name',
  nicknameHint: '2–20 characters: letters, numbers, - or _. Start with a letter or number.',
  deviceNote:
    "Nearby gives you a name on this device only. There's no email or password. If you clear this browser's data or switch devices, you'll start again with a new name.",
  submit: 'Start chatting',
  creating: 'Creating…',
  errorEmpty: 'Enter a name.',
  errorInvalid:
    'Names are 2–20 characters: letters, numbers, - or _, starting with a letter or number.',
  errorTaken: 'That name is taken. Try another.',
  errorUnavailable: "Nearby can't create names right now. Try again in a few seconds.",
  errorFailed: 'Something went wrong. Try again.',
  returningHeading: 'Welcome back',
  continueAs: (name: string): string => `Continue as ${name}`,
  tryAgain: 'Try again',
  startOver: 'Start over with a new name',
  connecting: (name: string): string => `Signing you in as ${name}…`,
  cancel: 'Cancel',
  signOut: 'Sign out',
  notRemembered: "This name won't be remembered on this device.",
  identityInvalid:
    "Nearby can't confirm your name anymore. You can keep chatting for now, or start over with a new name.",
  identityInvalidAction: 'Start over',
  confirmTitle: 'Start over with a new name?',
  confirmBody: "Your current name can't be recovered.",
  confirmAction: 'Start over',
} as const;

const ONBOARD_ERRORS = {
  empty: IDENTITY_TEXT.errorEmpty,
  invalid: IDENTITY_TEXT.errorInvalid,
  taken: IDENTITY_TEXT.errorTaken,
  unavailable: IDENTITY_TEXT.errorUnavailable,
  failed: IDENTITY_TEXT.errorFailed,
} satisfies Record<OnboardError, string>;

export function describeOnboardError(e: OnboardError): string {
  return ONBOARD_ERRORS[e];
}

export const CONNECTION_TEXT = {
  statusReconnecting: 'Reconnecting…',
  bannerLost: 'Connection lost.',
  bannerAutoRetry: "We'll reconnect automatically.",
  bannerRetryIn: (seconds: number): string => `Reconnecting in ${seconds}s…`,
  bannerRetrying: 'Reconnecting…',
  retryNow: 'Try now',
  roomReconnecting: 'Reconnecting to the room…',
  roomReconnectingEmpty: 'Reconnecting… messages will appear here.',
} as const;

export const HISTORY_TEXT = {
  loading: 'Loading recent messages…',
  emptyLoading: 'Loading recent messages…',
  failed: "Couldn't load recent messages.",
  retry: 'Try again',
  loadEarlier: 'Load earlier messages',
  loadingEarlier: 'Loading earlier messages…',
  earlierFailed: "Couldn't load earlier messages.",
  gapTruncated: "Some messages from while you were away couldn't be loaded.",
} as const;

export const AREA_TEXT = {
  heading: 'Your area',
  areaLabel: (code: string): string => `Area ${code}`,
  testSpotBadge: 'Test spot',
  left: 'You left the room',
  checking: 'Checking location access…',
  idle: 'Nearby uses your location to put you in a chat with people around you. Your exact location is never shared or stored.',
  share: 'Share my location',
  requesting: 'Finding your location… Your browser may ask for permission.',
  denied:
    "Location is off for this site. If you dismissed the prompt, try again. If you blocked it, allow location in your browser's site settings, then try again.",
  deniedDevHint: 'Or choose a test location below.',
  unavailable: "We couldn't find your location. Check that location services are on, then try again.",
  timeout: 'Finding your location took too long.',
  unsupported: "This browser can't share your location, so we can't find people nearby.",
  insecure: 'Location only works on a secure (https) page.',
  tryAgain: 'Try location again',
  moved: 'You seem to have moved.',
  switchArea: 'Switch to my new area',
  joining: (label: string): string => `Joining ${label}…`,
  rejoin: 'Join again',
  emptyNoArea: 'Share your location to chat with people nearby.',
  emptyJoining: 'Getting your area chat ready…',
} as const;
