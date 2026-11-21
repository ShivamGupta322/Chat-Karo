import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Welcome, type WelcomeProps } from '../../src/pages/Welcome';
import { IDENTITY_TEXT } from '../../src/ui/text';

type NewProps = Extract<WelcomeProps, { view: 'new' }>;
type ReturningProps = Extract<WelcomeProps, { view: 'returning' }>;

function renderNew(props: Partial<NewProps> = {}): { onCreate: ReturnType<typeof vi.fn> } {
  const onCreate = vi.fn();
  render(<Welcome view="new" busy={false} error={null} onCreate={onCreate} {...props} />);
  return { onCreate };
}

function renderReturning(props: Partial<ReturningProps> = {}): {
  onContinue: ReturnType<typeof vi.fn>;
  onStartOver: ReturnType<typeof vi.fn>;
} {
  const onContinue = vi.fn();
  const onStartOver = vi.fn();
  render(
    <Welcome
      view="returning"
      nickname="Alice_1"
      busy={false}
      error={null}
      onContinue={onContinue}
      onStartOver={onStartOver}
      {...props}
    />,
  );
  return { onContinue, onStartOver };
}

describe('Welcome: new', () => {
  it('does not steal focus from an element that already has it', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    renderNew();
    expect(outside).toHaveFocus();
    outside.remove();
  });

  it('takes focus on its heading when focus was lost', () => {
    renderNew();
    expect(screen.getByRole('heading', { level: 2, name: IDENTITY_TEXT.heading })).toHaveFocus();
  });

  it('has a labelled input, a linked hint, the device note and both headings', () => {
    renderNew();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Nearby');
    expect(screen.getByRole('heading', { level: 2, name: IDENTITY_TEXT.heading })).toBeInTheDocument();
    const input = screen.getByLabelText(IDENTITY_TEXT.nicknameLabel);
    expect(input).toHaveAttribute('id', 'nickname');
    expect(input).toHaveAttribute('maxlength', '20');
    expect(input).toHaveAttribute('autocomplete', 'nickname');
    expect(input).toHaveAccessibleDescription(IDENTITY_TEXT.nicknameHint);
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.getByText(IDENTITY_TEXT.deviceNote)).toBeInTheDocument();
    expect(screen.getByText(IDENTITY_TEXT.tagline)).toBeInTheDocument();
  });

  it('shows the empty error, marks the field invalid, focuses it and does not submit', async () => {
    const user = userEvent.setup({ delay: null });
    const { onCreate } = renderNew();
    await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.submit }));
    const input = screen.getByLabelText(IDENTITY_TEXT.nicknameLabel);
    expect(screen.getByText(IDENTITY_TEXT.errorEmpty)).toHaveAttribute('id', 'nickname-error');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain('nickname-error');
    expect(input).toHaveFocus();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('rejects a one-character name locally', async () => {
    const user = userEvent.setup({ delay: null });
    const { onCreate } = renderNew();
    await user.type(screen.getByLabelText(IDENTITY_TEXT.nicknameLabel), 'a');
    await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.submit }));
    expect(screen.getByText(IDENTITY_TEXT.errorInvalid)).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('clears the local error when the user edits', async () => {
    const user = userEvent.setup({ delay: null });
    renderNew();
    await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.submit }));
    await user.type(screen.getByLabelText(IDENTITY_TEXT.nicknameLabel), 'a');
    expect(screen.queryByText(IDENTITY_TEXT.errorEmpty)).toBeNull();
  });

  it('submits the trimmed name', async () => {
    const user = userEvent.setup({ delay: null });
    const { onCreate } = renderNew();
    await user.type(screen.getByLabelText(IDENTITY_TEXT.nicknameLabel), '  Alice ');
    await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.submit }));
    expect(onCreate).toHaveBeenCalledWith('Alice');
  });

  it('is busy: shows Creating…, aria-disabled, and Enter does not submit', async () => {
    const user = userEvent.setup({ delay: null });
    const { onCreate } = renderNew({ busy: true });
    const button = screen.getByRole('button', { name: IDENTITY_TEXT.creating });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    await user.type(screen.getByLabelText(IDENTITY_TEXT.nicknameLabel), 'Alice{Enter}');
    await user.click(button);
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('shows a taken error on the field, focuses it, and hides it when edited', async () => {
    const user = userEvent.setup({ delay: null });
    const onCreate = vi.fn();
    const { rerender } = render(<Welcome view="new" busy={false} error={null} onCreate={onCreate} />);
    const input = screen.getByLabelText(IDENTITY_TEXT.nicknameLabel);
    await user.type(input, 'Alice');
    await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.submit }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    (document.activeElement as HTMLElement).blur();
    rerender(<Welcome view="new" busy={false} error="taken" onCreate={onCreate} />);
    expect(screen.getByText(IDENTITY_TEXT.errorTaken)).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveFocus();
    await user.type(input, '2');
    expect(screen.queryByText(IDENTITY_TEXT.errorTaken)).toBeNull();
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('shows an unavailable error as an alert with the exact copy', async () => {
    const user = userEvent.setup({ delay: null });
    const onCreate = vi.fn();
    const { rerender } = render(<Welcome view="new" busy={false} error={null} onCreate={onCreate} />);
    await user.type(screen.getByLabelText(IDENTITY_TEXT.nicknameLabel), 'Alice');
    await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.submit }));
    rerender(<Welcome view="new" busy={false} error="unavailable" onCreate={onCreate} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Nearby can't create names right now. Try again in a few seconds.",
    );
    expect(screen.getByLabelText(IDENTITY_TEXT.nicknameLabel)).not.toHaveAttribute('aria-invalid');
  });

  it('works by keyboard only: Tab to the input, type, Enter', async () => {
    const user = userEvent.setup({ delay: null });
    const { onCreate } = renderNew();
    await user.tab();
    expect(screen.getByLabelText(IDENTITY_TEXT.nicknameLabel)).toHaveFocus();
    await user.keyboard('Alice_1{Enter}');
    expect(onCreate).toHaveBeenCalledWith('Alice_1');
  });
});

describe('Welcome: returning', () => {
  it('continues as the stored name', async () => {
    const user = userEvent.setup({ delay: null });
    const { onContinue } = renderReturning();
    expect(screen.getByRole('heading', { level: 2, name: IDENTITY_TEXT.returningHeading })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue as Alice_1' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the connection error and Try again', async () => {
    const user = userEvent.setup({ delay: null });
    const { onContinue } = renderReturning({ error: { reason: 'auth-failed' } });
    expect(screen.getByRole('alert')).toHaveTextContent("Nearby couldn't sign you in with this name.");
    expect(screen.queryByRole('button', { name: /Continue as/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.tryAgain }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('ignores both buttons while busy', async () => {
    const user = userEvent.setup({ delay: null });
    const { onContinue } = renderReturning({ busy: true });
    const cont = screen.getByRole('button', { name: 'Continue as Alice_1' });
    expect(cont).toHaveAttribute('aria-disabled', 'true');
    await user.click(cont);
    await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.startOver }));
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks before starting over; Cancel keeps the name and returns focus to the trigger', async () => {
    const user = userEvent.setup({ delay: null });
    const { onStartOver } = renderReturning();
    const trigger = screen.getByRole('button', { name: IDENTITY_TEXT.startOver });
    await user.click(trigger);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.cancel }));
    expect(onStartOver).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('confirming starts over exactly once', async () => {
    const user = userEvent.setup({ delay: null });
    const { onStartOver } = renderReturning();
    await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.startOver }));
    await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.confirmAction }));
    expect(onStartOver).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('Welcome: connecting', () => {
  it('shows the status text and a Cancel that is not trapped behind a hung connection', async () => {
    const user = userEvent.setup({ delay: null });
    const onCancel = vi.fn();
    render(<Welcome view="connecting" nickname="Alice_1" onCancel={onCancel} />);
    expect(screen.getByRole('status')).toHaveTextContent('Signing you in as Alice_1…');
    await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.cancel }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
