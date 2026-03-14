import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { teachersTable, examsTable, examSessionsTable, studentsTable, violationsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { TeacherSignUpBody, TeacherSignInBody } from "@workspace/api-zod";
import { hashPassword, verifyPassword } from "../lib/hash.js";
import crypto from "crypto";
import multer from "multer";
import OpenAI from "openai";
import { PDFDocument } from "pdf-lib";

const router: IRouter = Router();

// Configure Multer for PDF uploads
const upload = multer({ storage: multer.memoryStorage() });

// Configure OpenAI client for LM Studio (local server)
const lmStudio = new OpenAI({
  baseURL: "http://127.0.0.1:1234/v1", // Using direct IP for reliability
  apiKey: "not-needed",
});

router.post("/signup", async (req, res) => {
  const parsed = TeacherSignUpBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  const { username, password, fullName } = parsed.data;
  const [existing] = await db.select().from(teachersTable).where(eq(teachersTable.username, username));
  if (existing) {
    return res.status(409).json({ error: "Username already taken" });
  }
  const passwordHash = hashPassword(password);
  await db.insert(teachersTable).values({ username, passwordHash, fullName });
  const token = crypto.randomBytes(32).toString("hex");
  return res.status(201).json({ token, username, fullName });
});

router.post("/signin", async (req, res) => {
  const parsed = TeacherSignInBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  const { username, password } = parsed.data;
  const [teacher] = await db.select().from(teachersTable).where(eq(teachersTable.username, username));
  if (!teacher || !verifyPassword(password, teacher.passwordHash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  return res.json({ token, username: teacher.username, fullName: teacher.fullName });
});

router.get("/exams", async (req, res) => {
  const teacherName = req.query.teacherName as string;
  if (!teacherName) return res.status(400).json({ error: "teacherName is required" });

  const exams = await db.select().from(examsTable).where(eq(examsTable.teacherName, teacherName));

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

router.get("/exams/:examId/sessions", async (req, res) => {
  const examId = parseInt(req.params.examId);
  if (isNaN(examId)) return res.status(400).json({ error: "Invalid exam ID" });

  const sessions = await db
    .select({
      sessionId: examSessionsTable.id,
      studentId: studentsTable.id,
      usn: studentsTable.usn,
      studentName: studentsTable.studentName,
      examId: examsTable.id,
      examTitle: examsTable.title,
      examQuestions: examsTable.questions,
      status: examSessionsTable.status,
      joinedAt: examSessionsTable.joinedAt,
      score: examSessionsTable.score,
      answers: examSessionsTable.answers,
    })
    .from(examSessionsTable)
    .innerJoin(studentsTable, eq(examSessionsTable.studentId, studentsTable.id))
    .innerJoin(examsTable, eq(examSessionsTable.examId, examsTable.id))
    .where(eq(examSessionsTable.examId, examId));

  const enriched = await Promise.all(
    sessions.map(async (s) => {
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
        score: s.score ?? 0,
        answers: s.answers ?? {},
        examQuestions: s.examQuestions,
      };
    })
  );

  return res.json({ sessions: enriched });
});

router.post("/generate-questions", upload.single("file"), async (req, res) => {
  try {
    const { difficulty, questionTypes: typesJson } = req.body;
    const requestedTypes = typesJson ? JSON.parse(typesJson) : ["multiple_choice", "short_answer"];
    
    console.log("--- AI Generation Started ---");
    console.log("Difficulty:", difficulty);
    console.log("Types:", requestedTypes);
    
    if (!req.file) {
      console.error("No file received in request");
      return res.status(400).json({ error: "No PDF file uploaded" });
    }
    console.log("File received:", req.file.originalname, "(", req.file.size, "bytes )");

    // 1. Extract text from PDF
    let text = "";
    try {
      const pdfDoc = await PDFDocument.load(req.file.buffer);
      const pages = pdfDoc.getPages();
      console.log("PDF loaded successfully with pdf-lib. Pages:", pages.length);
      
      // Get raw string and scrub technical metadata
      let rawText = req.file.buffer.toString('utf-8');
      
      // Remove common PDF technical metadata blocks
      rawText = rawText.replace(/FontName|BaseFont|Encoding|CIDFontType2|ZapfDingbats|Arial|TimesNewRoman/gi, "");
      rawText = rawText.replace(/[^\x20-\x7E\n]/g, ""); // Keep only printable characters
      
      // Shift extraction to skip the very first technical headers
      text = rawText.substring(200, 3000).trim();
    } catch (pdfErr: any) {
      console.error("PDF Parsing Error:", pdfErr.message);
      return res.status(500).json({ error: `PDF Read Error: ${pdfErr.message}` });
    }

    if (!text || text.trim().length < 10) {
      console.error("Extracted text is too short or empty");
      return res.status(400).json({ error: "PDF content is not readable text" });
    }

    // 2. Prepare Prompt
    const prompt = `
      You are an elite academic examiner. Your task is to create an exam based EXCLUSIVELY on the provided textbook content.
      
      TEXT CONTENT TO ANALYZE:
      "${text.substring(0, 2500)}"

      STRICT RULES:
      1. ONLY ask about the facts, concepts, and details described in the text above (e.g., "What is the largest island?", "How are volcanic islands formed?").
      2. FORBIDDEN: Do not ask about the document itself (e.g., "What is the title?", "Who is the author?", "What is the font?").
      3. FORBIDDEN: Do not ask about the file (e.g., "What is the filename?", "How many pages?").
      4. MANDATORY: You MUST ONLY generate questions of these types: ${requestedTypes.join(", ")}. 
         - If "multiple_choice" is requested, provide 4 options and a correctAnswer.
         - If "true_false" is requested, provide exactly "True" and "False" as options.
         - If "short_answer" is requested, do not provide options.
      5. DIFFICULTY: Ensure the reasoning depth matches a "${difficulty}" level.
      
      OUTPUT FORMAT:
      Return ONLY a JSON object with this structure:
      {
        "questions": [
          {
            "text": "Conceptual question here...",
            "type": "one of: ${requestedTypes.join(", ")}",
            "options": ["Option A", "Option B", "Option C", "Option D"], // Only for MCQs and T/F
            "correctAnswer": "The exact correct option",
            "marks": 5
          }
        ]
      }
    `;

    // 3. Call LM Studio
    console.log("Sending request to LM Studio at http://127.0.0.1:1234/v1...");
    try {
      const completion = await lmStudio.chat.completions.create({
        model: "mistral-7b-instruct-v0.1",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
      });

      const content = completion.choices[0].message.content || "{}";
      console.log("LM Studio responded successfully.");
      
      let jsonStr = content.trim();
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }
      
      const generated = JSON.parse(jsonStr);
      console.log("JSON parsed successfully. Generated", generated.questions?.length, "questions.");
      return res.json(generated);
    } catch (aiErr: any) {
      console.error("LM Studio Connection/API Error:", aiErr.message);
      return res.status(500).json({ error: `AI Error: ${aiErr.message}` });
    }
  } catch (err: any) {
    console.error("Global Route Error:", err);
    return res.status(500).json({ error: err.message || "Internal Server Error" });
  }
});

export default router;
