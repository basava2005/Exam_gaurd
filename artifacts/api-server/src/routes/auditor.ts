import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { examsTable, studentsTable, examSessionsTable, violationsTable, auditorsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { AuditorSignInBody, AuditorSignUpBody } from "@workspace/api-zod";
import { hashPassword, verifyPassword } from "../lib/hash.js";
import crypto from "crypto";

const router: IRouter = Router();

router.post("/signup", async (req, res) => {
  const parsed = AuditorSignUpBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  const { username, password, fullName } = parsed.data;
  const [existing] = await db.select().from(auditorsTable).where(eq(auditorsTable.username, username));
  if (existing) {
    return res.status(409).json({ error: "Username already taken" });
  }
  const passwordHash = hashPassword(password);
  await db.insert(auditorsTable).values({ username, passwordHash, fullName });
  const token = crypto.randomBytes(32).toString("hex");
  return res.status(201).json({ token, username });
});

router.post("/signin", async (req, res) => {
  const parsed = AuditorSignInBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  const { username, password } = parsed.data;
  const [auditor] = await db.select().from(auditorsTable).where(eq(auditorsTable.username, username));
  if (!auditor || !verifyPassword(password, auditor.passwordHash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  return res.json({ token, username: auditor.username });
});

router.get("/sessions", async (req, res) => {
  try {
    const examIdParam = req.query.examId;
    let examId: number | undefined = undefined;
    
    if (examIdParam && examIdParam !== "undefined" && examIdParam !== "null") {
      const parsed = parseInt(examIdParam as string);
      if (!isNaN(parsed)) {
        examId = parsed;
      }
    }

    const sessions = await db
      .select({
        sessionId: examSessionsTable.id,
        studentId: studentsTable.id,
        usn: studentsTable.usn,
        studentName: studentsTable.studentName,
        examId: examsTable.id,
        examTitle: examsTable.title,
        joinCode: examsTable.joinCode,
        status: examSessionsTable.status,
        joinedAt: examSessionsTable.joinedAt,
      })
      .from(examSessionsTable)
      .innerJoin(studentsTable, eq(examSessionsTable.studentId, studentsTable.id))
      .innerJoin(examsTable, eq(examSessionsTable.examId, examsTable.id))
      .where(examId !== undefined ? eq(examSessionsTable.examId, examId) : undefined);

    const enriched = await Promise.all(
      sessions.map(async (s) => {
        try {
          const violations = await db
            .select()
            .from(violationsTable)
            .where(eq(violationsTable.sessionId, s.sessionId));

          const tabSwitches = violations.filter(v => v.type === "TAB_SWITCH").length;
          const windowResizes = violations.filter(v => v.type === "WINDOW_RESIZE").length;
          const keyboardAttempts = violations.filter(v => v.type === "KEYBOARD_ATTEMPT").length;
          const idleDetections = violations.filter(v => v.type === "IDLE_DETECTED").length;
          const multiVoiceDetections = violations.filter(v => v.type === "MULTIPLE_VOICES_DETECTED").length;

          let trustScore = 100;
          trustScore -= tabSwitches * 10;
          trustScore -= windowResizes * 5;
          trustScore -= keyboardAttempts * 15;
          trustScore -= idleDetections * 5;
          trustScore -= multiVoiceDetections * 10;
          trustScore = Math.max(0, trustScore);

          return {
            ...s,
            joinedAt: s.joinedAt.toISOString(),
            trustScore,
            violationCount: violations.length,
            violationBreakdown: {
              tabSwitches,
              windowResizes,
              keyboardAttempts,
              idleDetections,
              multiVoiceDetections,
            }
          };
        } catch (err) {
          console.error(`Error enriching session ${s.sessionId}:`, err);
          return {
            ...s,
            joinedAt: s.joinedAt.toISOString(),
            trustScore: 100,
            violationCount: 0,
            violationBreakdown: {}
          };
        }
      })
    );

    return res.json({ sessions: enriched });
  } catch (err) {
    console.error("Error in /sessions route:", err);
    return res.status(500).json({ error: "Internal Server Error", sessions: [] });
  }
});

router.get("/exams", async (_req, res) => {
  const exams = await db.select().from(examsTable);

  const enriched = await Promise.all(
    exams.map(async (exam) => {
      const [result] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(examSessionsTable)
        .where(eq(examSessionsTable.examId, exam.id));

      return {
        id: exam.id,
        title: exam.title,
        teacherName: exam.teacherName,
        joinCode: exam.joinCode,
        duration: exam.duration,
        studentCount: result?.count ?? 0,
        createdAt: exam.createdAt.toISOString(),
      };
    })
  );

  return res.json({ exams: enriched });
});

export default router;
