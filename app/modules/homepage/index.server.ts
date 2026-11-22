import { db } from "~/db";
import { getHomepage, type Db } from "./lib/homepage";

export type { FeaturedCourse, Homepage } from "./lib/homepage";

/**
 * The public homepage's figures bound to a database. The app uses
 * `homepage`, which reads the app database; tests build their own against a
 * test database.
 */
export function createHomepage(database: Db) {
  return {
    /**
     * The newest published courses (at most three, newest first, each with
     * its lesson count) and the catalogue totals shown on `/`.
     */
    get() {
      return getHomepage(database);
    },
  };
}

// Pure so a route importing this only for its loader doesn't pull the
// database into the client bundle (see `~/db`).
export const homepage = /* @__PURE__ */ createHomepage(db);
