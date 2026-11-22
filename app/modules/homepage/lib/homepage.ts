import { count, desc, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { CourseStatus } from "~/db/schema";

export type Db = BetterSQLite3Database<typeof schema>;

export const FEATURED_COURSE_LIMIT = 3;

export type FeaturedCourse = {
  id: number;
  title: string;
  slug: string;
  description: string;
  coverImageUrl: string | null;
  instructorName: string;
  lessonCount: number;
};

export type Homepage = {
  featuredCourses: FeaturedCourse[];
  totalCourses: number;
  totalCategories: number;
};

export function getHomepage(database: Db): Homepage {
  const featured = getNewestPublishedCourses(database);
  const lessonCounts = countLessonsByCourse(
    database,
    featured.map((course) => course.id)
  );

  return {
    featuredCourses: featured.map((course) => ({
      ...course,
      lessonCount: lessonCounts.get(course.id) ?? 0,
    })),
    totalCourses: countPublishedCourses(database),
    totalCategories: countCategories(database),
  };
}

function getNewestPublishedCourses(database: Db) {
  return database
    .select({
      id: schema.courses.id,
      title: schema.courses.title,
      slug: schema.courses.slug,
      description: schema.courses.description,
      coverImageUrl: schema.courses.coverImageUrl,
      instructorName: schema.users.name,
    })
    .from(schema.courses)
    .innerJoin(schema.users, eq(schema.courses.instructorId, schema.users.id))
    .where(eq(schema.courses.status, CourseStatus.Published))
    .orderBy(desc(schema.courses.createdAt), desc(schema.courses.id))
    .limit(FEATURED_COURSE_LIMIT)
    .all();
}

function countLessonsByCourse(database: Db, courseIds: number[]) {
  const rows = database
    .select({
      courseId: schema.modules.courseId,
      lessonCount: count(schema.lessons.id),
    })
    .from(schema.modules)
    .innerJoin(schema.lessons, eq(schema.lessons.moduleId, schema.modules.id))
    .where(inArray(schema.modules.courseId, courseIds))
    .groupBy(schema.modules.courseId)
    .all();

  return new Map(rows.map((row) => [row.courseId, row.lessonCount]));
}

function countPublishedCourses(database: Db) {
  const row = database
    .select({ total: count() })
    .from(schema.courses)
    .where(eq(schema.courses.status, CourseStatus.Published))
    .get();
  return row?.total ?? 0;
}

function countCategories(database: Db) {
  const row = database.select({ total: count() }).from(schema.categories).get();
  return row?.total ?? 0;
}
