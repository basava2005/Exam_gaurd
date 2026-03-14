import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { violationsTable, studentsTable, examSessionsTable } from "@workspace/db";
import { eq, and, desc, asc } from "drizzle-orm";
import { LogViolationBody } from "@workspace/api-zod";
import crypto from "crypto";

const router: IRouter = Router();

router.post("/violations", async (req, res) => {
  const parsed = LogViolationBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  const { sessionId, studentId, type, metadata } = parsed.data;

  // 1. Get the previous violation for this session to link the chain
  const [lastViolation] = await db
    .select()
    .from(violationsTable)
    .where(eq(violationsTable.sessionId, sessionId))
    .orderBy(desc(violationsTable.id))
    .limit(1);

  const previousHash = lastViolation?.hash || "0000000000000000000000000000000000000000000000000000000000000000";

  // 2. Calculate SHA-256 hash for the current violation (the "Block")
  const dataToHash = JSON.stringify({
    sessionId,
    studentId,
    type,
    metadata,
    previousHash,
  });
  
  const currentHash = crypto.createHash("sha256").update(dataToHash).digest("hex");

  // 3. Store the violation with its hash and link to the previous one
  const [violation] = await db.insert(violationsTable).values({
    sessionId,
    studentId,
    type,
    metadata: (metadata as Record<string, unknown>) ?? null,
    hash: currentHash,
    previousHash: previousHash,
  }).returning();

  return res.status(201).json({
    ...violation,
    timestamp: violation.timestamp.toISOString(),
  });
});

router.get("/violations/sessions/:sessionId/verify", async (req, res) => {
  const sessionId = parseInt(req.params.sessionId);
  if (isNaN(sessionId)) return res.status(400).json({ error: "Invalid session ID" });
  
  const violations = await db
    .select()
    .from(violationsTable)
    .where(eq(violationsTable.sessionId, sessionId))
    .orderBy(asc(violationsTable.id));
    
  let isValid = true;
  let corruptedIndex = -1;
  
  for (let i = 0; i < violations.length; i++) {
    const v = violations[i];
    const prevHash = i === 0 
      ? "0000000000000000000000000000000000000000000000000000000000000000" 
      : violations[i-1].hash;
      
    // Re-calculate hash to verify
    const dataToHash = JSON.stringify({
      sessionId: v.sessionId,
      studentId: v.studentId,
      type: v.type,
      metadata: v.metadata,
      previousHash: prevHash,
    });
    
    const calculatedHash = crypto.createHash("sha256").update(dataToHash).digest("hex");
    
    if (calculatedHash !== v.hash || v.previousHash !== prevHash) {
      isValid = false;
      corruptedIndex = i;
      break;
    }
  }
  
  return res.json({
    isValid,
    totalRecords: violations.length,
    corruptedIndex: corruptedIndex !== -1 ? corruptedIndex : null,
    status: isValid ? "Verified" : "Tampered",
    timestamp: new Date().toISOString()
  });
});

router.get("/violations/sessions/:sessionId/logs", async (req, res) => {
  const sessionId = parseInt(req.params.sessionId);
  if (isNaN(sessionId)) return res.status(400).json({ error: "Invalid session ID" });
  
  const [session] = await db
    .select({
      studentName: studentsTable.studentName,
      usn: studentsTable.usn,
    })
    .from(examSessionsTable)
    .innerJoin(studentsTable, eq(examSessionsTable.studentId, studentsTable.id))
    .where(eq(examSessionsTable.id, sessionId));
    
  if (!session) return res.status(404).json({ error: "Session not found" });
  
  const violations = await db
    .select()
    .from(violationsTable)
    .where(eq(violationsTable.sessionId, sessionId));
    
  return res.json({
    studentName: session.studentName,
    usn: session.usn,
    violations: violations.map(v => ({
      ...v,
      timestamp: v.timestamp.toISOString(),
    })),
  });
});

router.get("/students/:studentId/logs", async (req, res) => {
  const studentId = parseInt(req.params.studentId);
  if (isNaN(studentId)) return res.status(400).json({ error: "Invalid student ID" });
  const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, studentId));
  if (!student) return res.status(404).json({ error: "Student not found" });
  const violations = await db.select().from(violationsTable).where(eq(violationsTable.studentId, studentId));
  return res.json({
    studentId: student.id,
    usn: student.usn,
    studentName: student.studentName,
    violations: violations.map(v => ({
      ...v,
      timestamp: v.timestamp.toISOString(),
    })),
  });
});

router.get("/students/:studentId/trust-score", async (req, res) => {
  const studentId = parseInt(req.params.studentId);
  if (isNaN(studentId)) return res.status(400).json({ error: "Invalid student ID" });
  const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, studentId));
  if (!student) return res.status(404).json({ error: "Student not found" });
  const violations = await db.select().from(violationsTable).where(eq(violationsTable.studentId, studentId));
  
  const tabSwitches = violations.filter(v => v.type === "TAB_SWITCH").length;
  const windowResizes = violations.filter(v => v.type === "WINDOW_RESIZE").length;
  const keyboardAttempts = violations.filter(v => v.type === "KEYBOARD_ATTEMPT").length;
  const idleDetections = violations.filter(v => v.type === "IDLE_DETECTED").length;
  const multiVoiceDetections = violations.filter(v => v.type === "MULTIPLE_VOICES_DETECTED").length;
  
  let score = 100;
  score -= tabSwitches * 10;
  score -= windowResizes * 5;
  score -= keyboardAttempts * 15;
  score -= idleDetections * 5;
  score -= multiVoiceDetections * 10;
  score = Math.max(0, score);
  
  return res.json({
    studentId: student.id,
    usn: student.usn,
    studentName: student.studentName,
    trustScore: score,
    breakdown: { tabSwitches, windowResizes, keyboardAttempts, idleDetections, multiVoiceDetections },
  });
});

export default router;
