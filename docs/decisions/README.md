# Architecture Decision Records (ADRs)

An ADR here records the "why" behind a cross-cutting default or decision — context, alternatives, and rationale — so the behavior is an accountable, versioned commitment rather than tribal knowledge.

**Records are not updated after acceptance.** An ADR captures the context *as it stood on its date* — a record written pre-1.0 still says so, and that is deliberate. The **Status** and **Date** fields are the authority on whether a decision is still in force; the surrounding prose is history, not a description of the project today.

## Records

- [2026-07-07-verification-strictness-and-fidelity.md](./2026-07-07-verification-strictness-and-fidelity.md) — Decision record: verification strictness and fidelity defaults. Tightens assertion/verdict semantics so missing or incomplete evidence fails instead of silently passing, makes cassette replay strict by default, hardens verdict modifiers and parse-time key validation, and records two binary-verified fidelity behaviors (decisions D1–D6).
