# AURIS — AI VOICE-AGENT PLATFORM

Auris is an independently controlled, enterprise-grade AI voice-agent telecalling platform built for high-throughput outbound instant dialing, paced bulk campaigns, and 24/7 inbound receptionist desks.

---

## 1. Architecture Overview

Auris is architected as an event-driven system with clear separation between the transactional control plane and regional latency-sensitive streaming voice runtimes:

- **Frontend (`apps/web`):** Next.js 15 (App Router), React 19, TypeScript, Vanilla CSS design system.
- **Control Plane API (`apps/api`):** Fastify, TypeScript, OpenAPI 3.1 / Swagger, JWT Authentication, Multi-Tenant RBAC, Wallet Ledger Engine.
- **Database (`packages/database`):** PostgreSQL 16 managed via Prisma ORM with strict foreign keys, unique constraints, and row-level locking for atomic billing.
- **Mock Adapters:** Replaceable mock telephony (`ITelephonyAdapter`) and speech AI (`ISpeechToTextAdapter`, `ITextToSpeechAdapter`, `IConversationEngine`) enabling offline testing with zero external costs.

---

## 2. Local Development Setup

### Prerequisites
- Node.js >= 20 (Tested on Node.js v22.20.0)
- npm >= 10 (Tested on npm 10.9.3)
- Docker Desktop (Running)

### Quickstart

1. **Clone & Install Dependencies:**
   ```bash
   npm install
   ```

2. **Start Development Database:**
   ```bash
   docker compose up -d
   ```
   *Spins up an isolated PostgreSQL 16 container (`auris-postgres`) on port `5434`.*

3. **Run Database Migrations & Seeds:**
   ```bash
   npm run db:migrate -- --name init
   npm run db:seed
   ```
   *Seeds the default organization (`clinicxs`), admin user (`vikasreddyk0@gmail.com`), initial ₹50.00 wallet, compliance policy, and seed agent (`Sneha - Lead Qualifier`).*

4. **Run Automated Test Suite:**
   ```bash
   npm test
   ```
   *Executes 267 automated unit and integration tests covering tariff calculations, atomic balance reservation, concurrency overspend prevention, duplicate settlement idempotency, unanswered call release, and cross-tenant access isolation.*

5. **Start Services:**
   - **Start Control Plane API:**
     ```bash
     npm run dev:api
     ```
     - API Server: `http://localhost:4005`
     - Interactive Swagger API Docs: `http://localhost:4005/documentation`
   - **Start Next.js Frontend:**
     ```bash
     npm run dev:web
     ```
     - Frontend Web App: `http://localhost:3000`

---

## 3. Financial & Billing Invariants

1. **Pre-Call Balance Reservation:** No call can be initiated without holding funds in advance (`(balance_credits - reserved_credits) >= requested_hold`). Insufficient funds reject with HTTP 402.
2. **Atomic Ledger Tracking:** All changes to `balance_credits` and `reserved_credits` are executed via transactional row locks (`SELECT ... FOR UPDATE`), mathematically preventing concurrent overspending.
3. **30-Second Block Ceiling:** Calls are billed in 30-second blocks. Calls under 30s bill for 30s; 31s bills for 60s.
4. **Idempotent Settlement:** Re-delivering a settlement callback with the same `callId` returns `ALREADY_SETTLED` without deducting balances again.
5. **Zero-Charge for Unanswered Calls:** Busy, failed, or unanswered calls release 100% of the held reservation at ₹0 net charge.
