import { createContext, useContext, type ReactNode } from 'react';
import type { IdentityController } from './identityController';

const IdentityContext = createContext<IdentityController | null>(null);

export function IdentityProvider({
  controller,
  children,
}: {
  controller: IdentityController;
  children: ReactNode;
}): React.JSX.Element {
  return <IdentityContext.Provider value={controller}>{children}</IdentityContext.Provider>;
}

export function useIdentityController(): IdentityController {
  const controller = useContext(IdentityContext);
  if (!controller) throw new Error('useIdentityController must be used inside <IdentityProvider>');
  return controller;
}
