/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_XMPP_WS_URL?: string;
  readonly VITE_XMPP_DOMAIN?: string;
  readonly VITE_XMPP_MUC_DOMAIN?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_MAP_TILE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
