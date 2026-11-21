import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IdentityNotice } from '../../src/components/IdentityNotice';
import { IDENTITY_TEXT } from '../../src/ui/text';

describe('IdentityNotice', () => {
  it('renders nothing when the name is remembered and valid', () => {
    const { container } = render(
      <IdentityNotice remembered identityInvalid={false} onStartOver={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('says the name is not remembered, politely, as a status', () => {
    render(<IdentityNotice remembered={false} identityInvalid={false} onStartOver={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent(IDENTITY_TEXT.notRemembered);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('alerts that the name cannot be confirmed and offers Start over through the dialog', async () => {
    const user = userEvent.setup({ delay: null });
    const onStartOver = vi.fn();
    render(<IdentityNotice remembered identityInvalid onStartOver={onStartOver} />);
    expect(screen.getByRole('alert')).toHaveTextContent(IDENTITY_TEXT.identityInvalid);
    await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.identityInvalidAction }));
    expect(onStartOver).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onStartOver).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: IDENTITY_TEXT.identityInvalidAction }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: IDENTITY_TEXT.confirmAction }),
    );
    expect(onStartOver).toHaveBeenCalledTimes(1);
  });
});
