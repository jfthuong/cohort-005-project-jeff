import { slugify } from "./lib/impl";
import { withUniqueSuffix } from "./lib/unique";

/**
 * Starter template for a deep module: copy this folder or delete it.
 * One small entry point that does the whole job; the steps it puts together
 * live in `lib/`. An entry point that only forwards to one `lib/` function is
 * a Middle Man: give it real work.
 */
export function toSlug(title: string, taken: Iterable<string>): string {
  return withUniqueSuffix(slugify(title), new Set(taken));
}
