import { pgTable, text, serial, integer, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { studentsTable, examSessionsTable } from "./students";

export const violationsTable = pgTable("violations", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => examSessionsTable.id),
  studentId: integer("student_id").notNull().references(() => studentsTable.id),
  type: text("type").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  hash: text("hash"),
  previousHash: text("previous_hash"),
});

export const insertViolationSchema = createInsertSchema(violationsTable).omit({ id: true, timestamp: true });
export type InsertViolation = z.infer<typeof insertViolationSchema>;
export type Violation = typeof violationsTable.$inferSelect;
