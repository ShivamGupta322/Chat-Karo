import { Component, type ReactNode } from 'react';
import { DEV_MAP_TEXT } from './devLocationText';

/** A failed chunk load or a Leaflet error must never take down the chat. Deliberately silent: nothing is logged. */
export class DevMapBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <p role="status" className="m-0 text-sm text-ink-muted">
          {DEV_MAP_TEXT.failed}
        </p>
      );
    }
    return this.props.children;
  }
}
