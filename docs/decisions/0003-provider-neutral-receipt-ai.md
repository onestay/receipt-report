# ADR 0003: Provider-neutral receipt AI boundary

- Status: Accepted
- Date: 2026-07-18

## Context

Vision model quality, cost, privacy, and availability change over time. The
operator wants to choose the model rather than bind receipt data to one vendor.

## Decision

Define a small internal receipt-extraction interface and implement explicit
provider adapters. Validate all results against provider-independent Zod and
domain schemas.

## Consequences

Provider-specific structured-output and image behavior remains isolated. Some
adapter code is duplicated intentionally rather than hidden behind a broad AI
framework abstraction.
