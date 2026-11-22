// Public entry of src/api/. devIdentitySlot is imported directly by main.tsx only (dev-only code).
export { createHttp } from './http';
export type {
  ApiError,
  ApiResult,
  FetchLike,
  Http,
  HttpResponse,
  HttpResponseLike,
  PostOptions,
  TimerHandle,
  Timers,
} from './http';
export { NICKNAME_RE, validateNickname } from './nickname';
export type { NicknameResult } from './nickname';
export { RENEW_TIMEOUT_MS, SESSION_TIMEOUT_MS, createSessionApi } from './session';
export type { CreatedSession, RenewedSession, SessionApi } from './session';
export { CREDENTIAL_KEY, createCredentialStore } from './deviceCredential';
export type { CredentialStore, DeviceCredential } from './deviceCredential';
export { browserOnline, createTokenManager } from './tokenManager';
export type {
  OnlineSource,
  TokenAccess,
  TokenManager,
  TokenResult,
  TokenStatus,
  WithTokenResult,
} from './tokenManager';
