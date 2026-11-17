export { createXmppClient } from './client';
export { XmppProvider, useXmppClient } from './XmppProvider';
export { isValidRoomJid, normalizeNick, localpartOf, bareJid, resourceOf } from './jid';
export { installPageHideClose } from './pageHide';
export { installLifecycleTriggers } from './lifecycle';
export * from './types';
export type { XmppTransport, TransportStatus, IqResult } from './transport';
