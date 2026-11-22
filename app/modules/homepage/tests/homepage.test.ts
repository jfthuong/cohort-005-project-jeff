import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, seedBaseData, type TestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { CourseStatus } from "~/db/schema";
import { markdown } from "~/lib/text";
import { createHomepage } from "../index.server";

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

// ─── Fixtures ───
// The homepage only reads, so rows go in directly.

let slugCounter = 0;

function addCourse(
  title: string,
  createdAt: string,
  status = CourseStatus.Published
) {
  slugCounter += 1;
  return db
    .insert(schema.courses)
    .values({
      title,
      slug: `homepage-course-${slugCounter}`,
      description: title,
      salesCopy: markdown(title),
      instructorId: base.instructor.id,
      categoryId: base.category.id,
      status,
      createdAt,
    })
    .returning()
    .get();
}

function addLessons(courseId: number, lessonCount: number) {
  const mod = db
    .insert(schema.modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();
  for (let position = 1; position <= lessonCount; position++) {
    db.insert(schema.lessons)
      .values({ moduleId: mod.id, title: `Lesson ${position}`, position })
      .run();
  }
}

function addCategory(slug: string) {
  db.insert(schema.categories).values({ name: slug, slug }).run();
}

const homepage = () => createHomepage(db).get();

describe("homepage", () => {
  it("features the three newest published courses, newest first", () => {
    addCourse("Oldest", "2020-01-01T00:00:00.000Z");
    addCourse("Middle", "2030-01-01T00:00:00.000Z");
    addCourse("Draft", "2040-01-01T00:00:00.000Z", CourseStatus.Draft);
    addCourse("Newest", "2031-01-01T00:00:00.000Z");
    addCourse("Archived", "2041-01-01T00:00:00.000Z", CourseStatus.Archived);

    const titles = homepage().featuredCourses.map((course) => course.title);

    expect(titles).toEqual(["Newest", "Middle", "Test Course"]);
  });

  it("counts every lesson across a featured course's modules", () => {
    const course = addCourse("Two modules", "2030-01-01T00:00:00.000Z");
    addLessons(course.id, 2);
    addLessons(course.id, 3);
    addLessons(base.course.id, 1);

    const counts = Object.fromEntries(
      homepage().featuredCourses.map((c) => [c.title, c.lessonCount])
    );

    expect(counts).toEqual({ "Two modules": 5, "Test Course": 1 });
  });

  it("gives a course with no lessons a count of zero", () => {
    const [featured] = homepage().featuredCourses;

    expect(featured).toMatchObject({
      title: "Test Course",
      instructorName: "Test Instructor",
      lessonCount: 0,
    });
  });

  it("totals every published course and every category", () => {
    for (let i = 0; i < 4; i++) {
      addCourse(`Course ${i}`, "2030-01-01T00:00:00.000Z");
    }
    addCourse("Draft", "2030-01-01T00:00:00.000Z", CourseStatus.Draft);
    addCategory("design");

    const { featuredCourses, totalCourses, totalCategories } = homepage();

    expect(featuredCourses).toHaveLength(3);
    expect(totalCourses).toBe(5);
    expect(totalCategories).toBe(2);
  });

  it("has nothing to feature when no course is published", () => {
    db.update(schema.courses).set({ status: CourseStatus.Draft }).run();

    expect(homepage()).toMatchObject({ featuredCourses: [], totalCourses: 0 });
  });
});
