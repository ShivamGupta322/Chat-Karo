import { useState } from 'react';
import { IDENTITY_TEXT } from '../ui/text';
import { ConfirmDialog } from './ConfirmDialog';

export interface IdentityNoticeProps {
  remembered: boolean;
  identityInvalid: boolean;
  onStartOver: () => void;
}

export function IdentityNotice({
  remembered,
  identityInvalid,
  onStartOver,
}: IdentityNoticeProps): React.JSX.Element | null {
  const [confirming, setConfirming] = useState(false);
  if (remembered && !identityInvalid) return null;

  return (
    <div className="border-b border-line bg-surface-sunken text-ink">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm sm:px-4">
        {identityInvalid ? (
          <>
            <p role="alert" className="m-0 min-w-0">
              {IDENTITY_TEXT.identityInvalid}
            </p>
            <button
              type="button"
              onClick={() => {
                setConfirming(true);
              }}
              className="rounded-lg border border-field bg-surface px-3 py-1.5 text-sm hover:bg-surface-sunken"
            >
              {IDENTITY_TEXT.identityInvalidAction}
            </button>
          </>
        ) : (
          <p role="status" className="m-0 min-w-0">
            {IDENTITY_TEXT.notRemembered}
          </p>
        )}
      </div>
      {confirming && (
        <ConfirmDialog
          title={IDENTITY_TEXT.confirmTitle}
          body={IDENTITY_TEXT.confirmBody}
          confirmLabel={IDENTITY_TEXT.confirmAction}
          cancelLabel={IDENTITY_TEXT.cancel}
          onConfirm={() => {
            setConfirming(false);
            onStartOver();
          }}
          onCancel={() => {
            setConfirming(false);
          }}
        />
      )}
    </div>
  );
}
