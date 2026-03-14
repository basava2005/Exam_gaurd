# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server
│   └── exam-guardrail/     # React+Vite frontend app
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Application: Exam Guardrail System

A full-stack exam management platform with behavior monitoring.

### Features
- **Teacher Portal** (`/teacher`): Create question papers with MCQ, short answer, and true/false questions. Generates a unique 6-char join code.
- **Student Portal** (`/student`): Students join exams using USN/ID + join code. Live behavior monitoring during the exam.
- **Auditor Dashboard** (`/auditor`): Protected by sign-in (admin/admin123). Shows all student sessions with trust scores and violation timelines.

### Behavior Monitoring (Unique Feature)
During exams, the system monitors:
- **Tab switching** — logs when student leaves/returns to tab (-10 pts per occurrence)
- **Window resize** — flags if window shrinks below 80% of screen (-5 pts)
- **Keyboard shortcuts** — blocks & logs Ctrl+C, Ctrl+V, F12, PrintScreen (-15 pts)
- **Idle detection** — flags if no mouse/keyboard activity for 60s (-5 pts)

Trust score starts at 100 and decreases with violations.

### Auditor Credentials
- Username: `admin`
- Password: `admin123`

## Database Schema

- `exams` — exam details, join code, questions (JSON), duration
- `students` — student USN and name
- `exam_sessions` — session linking student to exam
- `violations` — violation events with type and metadata

## API Endpoints

- `POST /api/exams` — create exam
- `GET /api/exams/:id` — get exam
- `POST /api/exams/join` — student joins exam
- `POST /api/violations` — log violation
- `GET /api/students/:id/logs` — student violation history
- `GET /api/students/:id/trust-score` — computed trust score
- `POST /api/auditor/signin` — auditor authentication
- `GET /api/auditor/sessions` — all student sessions
- `GET /api/auditor/exams` — all exams

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

- **Always typecheck from the root** — run `pnpm run typecheck`
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references
