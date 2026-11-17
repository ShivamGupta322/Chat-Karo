export function LogoMark({
  className,
  title,
}: {
  className?: string;
  title?: string;
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path
        fill="var(--color-accent)"
        d="M16 2C9.4 2 4 7 4 13.2c0 4.3 2.6 8 6.4 9.9L16 30l5.6-6.9c3.8-1.9 6.4-5.6 6.4-9.9C28 7 22.6 2 16 2z"
      />
      <circle cx="11" cy="13" r="1.9" fill="var(--color-on-accent)" />
      <circle cx="16" cy="13" r="1.9" fill="var(--color-on-accent)" />
      <circle cx="21" cy="13" r="1.9" fill="var(--color-on-accent)" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <LogoMark className="size-7 shrink-0" />
      <span className="text-lg font-semibold tracking-tight">Nearby</span>
    </span>
  );
}
