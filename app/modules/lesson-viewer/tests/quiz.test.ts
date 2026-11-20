import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData, type TestDb } from "~/test/setup";
import * as schema from "~/db/schema";
import { QuestionType } from "~/db/schema";

let db: TestDb;

// quiz.server.ts reads the app-wide `db`; point it at an in-memory database.
vi.mock("~/db", () => ({
  get db() {
    return db;
  },
}));

const { computeResult, getQuizWithQuestions } = await import("../quiz.server");

let userId: number;
let quizId: number;
let questions: { id: number; correct: number; wrong: number }[];

// ─── Fixtures ───
// The lesson viewer only reads quizzes, so rows go in directly.

function addQuestion(position: number, questionType: QuestionType) {
  const question = db
    .insert(schema.quizQuestions)
    .values({ quizId, questionText: `Q${position}`, questionType, position })
    .returning()
    .get();
  const [wrong, correct] = [false, true].map(
    (isCorrect) =>
      db
        .insert(schema.quizOptions)
        .values({
          questionId: question.id,
          optionText: String(isCorrect),
          isCorrect,
        })
        .returning()
        .get().id
  );
  return { id: question.id, correct, wrong };
}

beforeEach(() => {
  db = createTestDb();
  const base = seedBaseData(db);
  userId = base.user.id;
  const mod = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "M", position: 1 })
    .returning()
    .get();
  const lesson = db
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: "L", position: 1 })
    .returning()
    .get();
  quizId = db
    .insert(schema.quizzes)
    .values({ lessonId: lesson.id, title: "Quiz", passingScore: 0.7 })
    .returning()
    .get().id;
  // Inserted out of position order to check questions come back ordered.
  questions = [
    addQuestion(2, QuestionType.TrueFalse),
    addQuestion(1, QuestionType.MultipleChoice),
    addQuestion(3, QuestionType.MultipleChoice),
  ];
});

describe("getQuizWithQuestions", () => {
  it("returns questions in position order, each with only its own options", () => {
    const quiz = getQuizWithQuestions(quizId);

    expect(quiz?.questions.map((q) => q.id)).toEqual([
      questions[1].id,
      questions[0].id,
      questions[2].id,
    ]);
    for (const question of quiz?.questions ?? []) {
      expect(question.options.map((o) => o.questionId)).toEqual([
        question.id,
        question.id,
      ]);
    }
  });

  it("is null for a quiz that does not exist", () => {
    expect(getQuizWithQuestions(quizId + 1)).toBeNull();
  });
});

describe("computeResult", () => {
  it("grades each question and stores the attempt with only the answered questions", () => {
    const result = computeResult(userId, quizId, {
      [questions[0].id]: questions[0].correct,
      [questions[1].id]: questions[1].wrong,
    });

    expect(result).toMatchObject({
      totalCorrect: 1,
      totalQuestions: 3,
      passed: false,
      grade: "F",
    });
    expect(result?.questionResults).toEqual([
      {
        questionId: questions[1].id,
        correct: false,
        selectedOptionId: questions[1].wrong,
        correctOptionId: questions[1].correct,
      },
      {
        questionId: questions[0].id,
        correct: true,
        selectedOptionId: questions[0].correct,
        correctOptionId: questions[0].correct,
      },
      {
        questionId: questions[2].id,
        correct: false,
        selectedOptionId: null,
        correctOptionId: null,
      },
    ]);
    const answers = db.select().from(schema.quizAnswers).all();
    expect(answers.map((a) => a.selectedOptionId).sort()).toEqual(
      [questions[0].correct, questions[1].wrong].sort()
    );
    expect(answers.every((a) => a.attemptId === result?.attemptId)).toBe(true);
  });

  it("passes with every answer right", () => {
    const answers = Object.fromEntries(questions.map((q) => [q.id, q.correct]));

    expect(computeResult(userId, quizId, answers)).toMatchObject({
      score: 1,
      passed: true,
      grade: "A",
    });
  });

  it("stores nothing when an answer cannot be saved", () => {
    const result = computeResult(userId, quizId, {
      [questions[0].id]: 999_999,
    });

    expect(result).toBeNull();
    expect(db.select().from(schema.quizAttempts).all()).toEqual([]);
  });
});
