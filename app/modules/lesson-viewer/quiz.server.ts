import { db } from "~/db";
import {
  quizzes,
  quizQuestions,
  quizOptions,
  quizAttempts,
  quizAnswers,
} from "~/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";

export function getQuizByLessonId(lessonId: number) {
  return db.select().from(quizzes).where(eq(quizzes.lessonId, lessonId)).get();
}

export function getQuizWithQuestions(quizId: number) {
  const quiz = getQuizById(quizId);
  if (!quiz) return null;

  const questions = getOrderedQuestions(quizId);
  const options = questions.length
    ? db
        .select()
        .from(quizOptions)
        .where(
          inArray(
            quizOptions.questionId,
            questions.map((question) => question.id)
          )
        )
        .all()
    : [];

  const questionsWithOptions = questions.map((question) => ({
    ...question,
    options: options.filter((option) => option.questionId === question.id),
  }));

  return { ...quiz, questions: questionsWithOptions };
}

function getOrderedQuestions(quizId: number) {
  return db
    .select()
    .from(quizQuestions)
    .where(eq(quizQuestions.quizId, quizId))
    .orderBy(quizQuestions.position)
    .all();
}

function getCorrectOptionIds(questionIds: number[]) {
  const correctOptionIds = new Map<number, number>();
  if (questionIds.length === 0) return correctOptionIds;

  const correctOptions = db
    .select({ id: quizOptions.id, questionId: quizOptions.questionId })
    .from(quizOptions)
    .where(
      and(
        inArray(quizOptions.questionId, questionIds),
        eq(quizOptions.isCorrect, true)
      )
    )
    .all();
  for (const option of correctOptions) {
    if (!correctOptionIds.has(option.questionId)) {
      correctOptionIds.set(option.questionId, option.id);
    }
  }
  return correctOptionIds;
}

export function getBestAttempt(userId: number, quizId: number) {
  return db
    .select()
    .from(quizAttempts)
    .where(
      and(eq(quizAttempts.userId, userId), eq(quizAttempts.quizId, quizId))
    )
    .orderBy(desc(quizAttempts.score))
    .limit(1)
    .get();
}

function calculateGrade(score: number): string {
  if (score >= 0.9) return "A";
  if (score >= 0.8) return "B";
  if (score >= 0.7) return "C";
  if (score >= 0.6) return "D";
  return "F";
}

type QuestionResult = {
  questionId: number;
  correct: boolean;
  selectedOptionId: number | null;
  correctOptionId: number | null;
};

function gradeQuestions(
  questionIds: number[],
  selectedAnswers: Record<number, number>
): QuestionResult[] {
  const correctOptionIds = getCorrectOptionIds(questionIds);
  return questionIds.map((questionId) => {
    const selected = selectedAnswers[questionId];
    if (!selected) {
      return {
        questionId,
        correct: false,
        selectedOptionId: null,
        correctOptionId: null,
      };
    }
    const correctOptionId = correctOptionIds.get(questionId) ?? null;
    return {
      questionId,
      correct: selected === correctOptionId,
      selectedOptionId: selected,
      correctOptionId,
    };
  });
}

function saveAttempt(
  attempt: typeof quizAttempts.$inferInsert,
  questionResults: QuestionResult[]
) {
  const answers = questionResults.flatMap((result) =>
    result.selectedOptionId === null
      ? []
      : [
          {
            questionId: result.questionId,
            selectedOptionId: result.selectedOptionId,
          },
        ]
  );
  return db.transaction((tx) => {
    const inserted = tx.insert(quizAttempts).values(attempt).returning().get();
    if (answers.length > 0) {
      tx.insert(quizAnswers)
        .values(
          answers.map((answer) => ({ ...answer, attemptId: inserted.id }))
        )
        .run();
    }
    return inserted;
  });
}

export function computeResult(
  userId: number,
  quizId: number,
  selectedAnswers: Record<number, number>
) {
  try {
    const quiz = getQuizById(quizId);
    if (!quiz) {
      console.error("quiz not found");
      return null;
    }

    const questions = getOrderedQuestions(quizId);

    const questionResults = gradeQuestions(
      questions.map((q) => q.id),
      selectedAnswers
    );
    const correct = questionResults.filter((r) => r.correct).length;
    const total = questions.length;

    const scoreValue = total > 0 ? correct / total : 0;
    const passed = scoreValue > 0.7;
    const grade = calculateGrade(scoreValue);

    const attempt = saveAttempt(
      { userId, quizId, score: scoreValue, passed },
      questionResults
    );

    return {
      attemptId: attempt.id,
      score: scoreValue,
      passed,
      grade,
      totalCorrect: correct,
      totalQuestions: total,
      questionResults,
    };
  } catch (error) {
    console.error(error);
    return null;
  }
}

export function getQuizById(quizId: number) {
  return db.select().from(quizzes).where(eq(quizzes.id, quizId)).get();
}
