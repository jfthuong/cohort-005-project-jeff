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
    const correctOptionIds = getCorrectOptionIds(questions.map((q) => q.id));

    let correct = 0;
    const total = questions.length;
    const questionResults: QuestionResult[] = [];

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const selected = selectedAnswers[q.id];

      if (!selected) {
        questionResults.push({
          questionId: q.id,
          correct: false,
          selectedOptionId: null,
          correctOptionId: null,
        });
        continue;
      }

      const correctOptionId = correctOptionIds.get(q.id) ?? null;

      const isCorrect = selected === correctOptionId;
      if (isCorrect) correct++;

      questionResults.push({
        questionId: q.id,
        correct: isCorrect,
        selectedOptionId: selected,
        correctOptionId,
      });
    }

    const scoreValue = total > 0 ? correct / total : 0;
    const passed = scoreValue > 0.7;
    const grade = calculateGrade(scoreValue);

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
    const attempt = db.transaction((tx) => {
      const inserted = tx
        .insert(quizAttempts)
        .values({ userId, quizId, score: scoreValue, passed })
        .returning()
        .get();
      if (answers.length > 0) {
        tx.insert(quizAnswers)
          .values(
            answers.map((answer) => ({ ...answer, attemptId: inserted.id }))
          )
          .run();
      }
      return inserted;
    });

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
