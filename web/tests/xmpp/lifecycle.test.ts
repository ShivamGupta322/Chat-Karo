import { describe, expect, it, vi } from 'vitest';
import { installLifecycleTriggers } from '../../src/xmpp/lifecycle';

function setup(): {
  wake: (trigger: 'visible' | 'online' | 'user') => void;
  win: EventTarget;
  doc: EventTarget & { visibilityState: DocumentVisibilityState };
  off: () => void;
} {
  const wake = vi.fn();
  const win = new EventTarget();
  const doc: EventTarget & { visibilityState: DocumentVisibilityState } = Object.assign(
    new EventTarget(),
    { visibilityState: 'visible' as const },
  );
  const off = installLifecycleTriggers({ wake }, win, doc);
  return { wake, win, doc, off };
}

describe('installLifecycleTriggers', () => {
  it('online wakes the client', () => {
    const { wake, win } = setup();
    win.dispatchEvent(new Event('online'));
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith('online');
  });

  it('visibilitychange wakes only when visible', () => {
    const { wake, doc } = setup();
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(wake).not.toHaveBeenCalled();
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith('visible');
  });

  it('does nothing after cleanup', () => {
    const { wake, win, doc, off } = setup();
    off();
    win.dispatchEvent(new Event('online'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(wake).not.toHaveBeenCalled();
  });
});
