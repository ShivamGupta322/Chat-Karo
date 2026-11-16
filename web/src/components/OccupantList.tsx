export interface OccupantListProps {
  occupants: string[];
  selfNick: string | null;
}

export function OccupantList({ occupants, selfNick }: OccupantListProps): React.JSX.Element {
  return (
    <section aria-labelledby="occupants-h">
      <h2 id="occupants-h" className="mb-1 text-sm font-semibold uppercase text-slate-500">
        Occupants ({occupants.length})
      </h2>
      <ul className="m-0 list-none p-0 text-sm">
        {occupants.map((n) => (
          <li key={n}>
            {n}
            {n === selfNick && <span className="text-slate-500"> (you)</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
