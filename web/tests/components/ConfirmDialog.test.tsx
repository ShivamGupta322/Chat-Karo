import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../../src/components/ConfirmDialog';

function renderDialog(): { onConfirm: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      title="Start over with a new name?"
      body="Your current name can't be recovered."
      confirmLabel="Start over"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe('ConfirmDialog', () => {
  it('is a modal alertdialog that is labelled and described', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog', { name: 'Start over with a new name?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription("Your current name can't be recovered.");
  });

  it('starts with focus on Cancel', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('keeps Tab and Shift+Tab inside the two buttons', async () => {
    const user = userEvent.setup({ delay: null });
    renderDialog();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Start over' });
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();
  });

  it('cancels on Escape and on a backdrop click, but not on a click inside', async () => {
    const user = userEvent.setup({ delay: null });
    const { onCancel } = renderDialog();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole('alertdialog');
    await user.click(dialog);
    expect(onCancel).toHaveBeenCalledTimes(1);
    const backdrop = dialog.parentElement;
    expect(backdrop).not.toBeNull();
    if (backdrop) await user.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('confirms through the destructive button', async () => {
    const user = userEvent.setup({ delay: null });
    const { onConfirm, onCancel } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Start over' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('returns focus to the opener when it closes', async () => {
    const user = userEvent.setup({ delay: null });
    function Host(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            Open
          </button>
          {open && (
            <ConfirmDialog
              title="T"
              body="B"
              confirmLabel="Yes"
              cancelLabel="No"
              onConfirm={() => {
                setOpen(false);
              }}
              onCancel={() => {
                setOpen(false);
              }}
            />
          )}
        </>
      );
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    expect(screen.getByRole('button', { name: 'No' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(opener).toHaveFocus();
  });
});
