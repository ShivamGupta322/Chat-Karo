export interface OccupantListProps {
  occupants: string[];
  selfNick: string | null;
}

function initial(name: string): string {
  const first = [...name][0] ?? '?';
  return first.toUpperCase();
}

export function OccupantList({ occupants, selfNick }: OccupantListProps): React.JSX.Element {
  return (
    <section
      aria-labelledby="occupants-h"
      className="rounded-2xl border border-line bg-surface p-3 shadow-sm sm:p-4"
    >
      <h2 id="occupants-h" className="m-0 mb-2 text-sm font-semibold">
        People here <span aria-hidden="true">·</span> {occupants.length}
      </h2>
      {occupants.length === 0 ? (
        <p className="m-0 text-sm text-ink-muted">No one here yet</p>
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-2 p-0 text-sm md:grid md:gap-2">
          {occupants.map((n) => (
            <li key={n} className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-xs font-semibold text-ink"
              >
                {initial(n)}
              </span>
              <span className="min-w-0 truncate">
                {n}
                {n === selfNick && <span className="text-ink-muted"> (you)</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
