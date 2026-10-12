/**
 * Where the action rules live. The file-backed store keeps them in
 * `<dataDir>/rules.json`; the in-memory one is for tests and for servers
 * started without a data directory.
 */
import { type Rule, RuleSet } from "@tiklive/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A save was based on an older revision than the current one (another tab saved first). */
export class RevisionConflict extends Schema.TaggedError<RevisionConflict>()("RevisionConflict", {
  expected: Schema.Finite,
  current: Schema.Finite,
}) {
  override get message() {
    return `Rules changed since revision ${this.expected} (now ${this.current}). Reload and try again.`;
  }
}

/** Writing rules to disk failed. The previous rules stay in effect. */
export class RulesWriteError extends Schema.TaggedError<RulesWriteError>()("RulesWriteError", {
  message: Schema.String,
}) {}

export class RulesStore extends Context.Service<
  RulesStore,
  {
    /** The current rules. Cheap: served from memory. */
    readonly get: Effect.Effect<RuleSet>;
    /**
     * Replaces every rule and bumps the revision by one. Fails with `RevisionConflict`
     * when `expected` isn't the current revision. Saves are serialized.
     */
    readonly replace: (
      expected: number,
      rules: ReadonlyArray<Rule>,
    ) => Effect.Effect<RuleSet, RevisionConflict | RulesWriteError>;
  }
>()("@tiklive/server/RulesStore") {}

const FILE = "rules.json";
const EMPTY: RuleSet = { revision: 0, rules: [] };

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Writes to `<file>.tmp` and renames over `file`, so readers never see a half-written file. */
const writeFileAtomic = (file: string, contents: string) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, contents);
      await rename(tmp, file);
    },
    catch: (cause) => cause,
  });

/**
 * Reads `rules.json`. A missing file means no rules yet. An unreadable or invalid one
 * is moved aside (`rules.json.broken-<time>`) and the server starts empty. Never fails.
 */
const loadRules = (dir: string): Effect.Effect<RuleSet> =>
  Effect.gen(function* () {
    const file = join(dir, FILE);
    const read = yield* Effect.result(
      Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: (cause) => cause }),
    );
    if (read._tag === "Failure") {
      if (errorCode(read.failure) !== "ENOENT") {
        yield* Effect.logWarning(`Could not read ${file}; starting with no action rules`, read.failure);
      }
      return EMPTY;
    }

    const decoded = yield* Effect.result(
      Effect.try({ try: () => JSON.parse(read.success) as unknown, catch: (cause) => cause }).pipe(
        Effect.flatMap((json) => Schema.decodeUnknownEffect(RuleSet)(json)),
      ),
    );
    if (decoded._tag === "Success") return decoded.success;

    const aside = `${file}.broken-${Date.now()}`;
    yield* Effect.logWarning(`Invalid action rules in ${file}; moving it to ${aside}`, decoded.failure);
    yield* Effect.tryPromise({ try: () => rename(file, aside), catch: (cause) => cause }).pipe(
      Effect.catch((cause) => Effect.logWarning(`Could not move ${file} aside`, cause)),
    );
    return EMPTY;
  });

/**
 * The store logic shared by both backends: revisions, conflicts and serialized saves.
 * Memory only changes after `persist` succeeds, so a failed write keeps the old rules.
 */
const makeStore = (initial: RuleSet, persist: (next: RuleSet) => Effect.Effect<void, RulesWriteError>) =>
  Effect.gen(function* () {
    const current = yield* Ref.make(initial);
    const lock = yield* Semaphore.make(1);
    return RulesStore.of({
      get: Ref.get(current),
      replace: (expected, rules) =>
        lock.withPermit(
          Effect.gen(function* () {
            const before = yield* Ref.get(current);
            if (expected !== before.revision) {
              return yield* Effect.fail(new RevisionConflict({ expected, current: before.revision }));
            }
            const next: RuleSet = { revision: before.revision + 1, rules: [...rules] };
            yield* persist(next);
            yield* Ref.set(current, next);
            return next;
          }),
        ),
    });
  });

/** Rules kept in memory only. Starts with `initial` (no rules by default). */
export const layerMemory = (initial: RuleSet = EMPTY): Layer.Layer<RulesStore> =>
  Layer.effect(
    RulesStore,
    makeStore(initial, () => Effect.void),
  );

/** Rules kept in `<dir>/rules.json`. Never fails: a bad file is moved aside and rules start empty. */
export const layerFile = (dir: string): Layer.Layer<RulesStore> => {
  const file = join(dir, FILE);
  return Layer.effect(
    RulesStore,
    Effect.gen(function* () {
      const initial = yield* loadRules(dir);
      return yield* makeStore(initial, (next) =>
        writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`).pipe(
          Effect.mapError(
            (cause) =>
              new RulesWriteError({ message: `Could not save rules to ${file}: ${describe(cause)}` }),
          ),
        ),
      );
    }),
  );
};
