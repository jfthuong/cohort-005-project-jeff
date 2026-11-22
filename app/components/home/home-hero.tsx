import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "~/components/ui/button";
import { CourseImage } from "~/components/course-image";
import { PAGE_WIDTH } from "./page-width";

type HeroCourse = { id: number; title: string; coverImageUrl: string | null };

export function HomeHero({
  signedIn,
  totalCourses,
  totalCategories,
  courses,
}: {
  signedIn: boolean;
  totalCourses: number;
  totalCategories: number;
  courses: HeroCourse[];
}) {
  return (
    <section className="border-b border-border">
      <div
        className={`${PAGE_WIDTH} grid items-center gap-12 py-20 lg:grid-cols-2 lg:py-24`}
      >
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Courses for developers · By working instructors
          </p>
          <h1 className="mt-5 text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl">
            Learn to code, at your own pace.
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted-foreground">
            Structured courses built by experienced instructors. Track your
            progress, take quizzes, and build real-world skills.
          </p>
          <HeroActions signedIn={signedIn} />
          <HeroStats
            totalCourses={totalCourses}
            totalCategories={totalCategories}
          />
        </div>
        <HeroArt courses={courses} />
      </div>
    </section>
  );
}

const CARD_TILTS = ["-rotate-6", "rotate-6", "-rotate-2"];

function HeroArt({ courses }: { courses: HeroCourse[] }) {
  return (
    <div
      aria-hidden
      className="relative hidden aspect-[4/3] overflow-hidden rounded-2xl bg-[linear-gradient(110deg,#fde68a_0%,#f9a8d4_22%,#818cf8_45%,#38bdf8_62%,#f472b6_80%,#fb923c_100%)] lg:block"
    >
      <div className="absolute inset-0 bg-gradient-to-t from-background/40 to-transparent" />
      <div className="absolute inset-0 flex items-center justify-center">
        {courses.map((course, index) => (
          <div
            key={course.id}
            className={`absolute w-3/5 overflow-hidden rounded-xl border border-white/40 bg-card shadow-2xl ${CARD_TILTS[index] ?? ""}`}
            style={{
              transform: `translate(${(index - 1) * 22}%, ${(index - 1) * 8}%)`,
            }}
          >
            <CourseImage
              src={course.coverImageUrl}
              alt=""
              className="aspect-video w-full object-cover"
            />
            {index === courses.length - 1 && (
              <p className="truncate px-4 py-3 text-sm font-semibold">
                {course.title}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function HeroStats({
  totalCourses,
  totalCategories,
}: {
  totalCourses: number;
  totalCategories: number;
}) {
  const stats = [
    { value: totalCourses, label: "Published courses" },
    { value: totalCategories, label: "Categories" },
    { value: "24/7", label: "On your schedule" },
  ];

  return (
    <dl className="mt-12 grid max-w-xl grid-cols-3 gap-6 border-t border-border pt-8">
      {stats.map((stat) => (
        <div key={stat.label}>
          <dt className="sr-only">{stat.label}</dt>
          <dd className="font-mono text-2xl font-semibold sm:text-3xl">
            {stat.value}
          </dd>
          <dd className="mt-1 font-mono text-[0.7rem] uppercase tracking-[0.15em] text-muted-foreground">
            {stat.label}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function HeroActions({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="mt-10 flex flex-wrap items-center gap-3">
      <Button asChild size="lg">
        <Link to="/courses">
          Browse courses
          <ArrowRight className="ml-1 size-4" />
        </Link>
      </Button>
      <Button asChild size="lg" variant="outline">
        {signedIn ? (
          <Link to="/dashboard">Go to your dashboard</Link>
        ) : (
          <Link to="/signup">Create a free account</Link>
        )}
      </Button>
    </div>
  );
}
