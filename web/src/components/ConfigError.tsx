import { Wordmark } from './Logo';

export function ConfigError({ errors }: { errors: string[] }): React.JSX.Element {
  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-md content-center p-4">
      <div className="grid gap-4 rounded-2xl border border-line bg-surface p-6 shadow-sm">
        <Wordmark />
        <h1 className="text-xl font-semibold">Nearby can't start</h1>
        <p className="text-sm">
          Fix these settings in the repo-root .env and restart the dev server:
        </p>
        <ul className="list-disc pl-5 text-sm text-danger">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
    </main>
  );
}
