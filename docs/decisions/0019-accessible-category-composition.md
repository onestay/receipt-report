# ADR 0019: Dependency-free accessible category composition

## Status

Accepted

## Context

Receipt detail and Spending Insights need one consistent category-composition
view. Values are signed: ordinary spend may be positive, while returns,
discounts, and reconciliation adjustments may be zero or negative. A circular
chart cannot truthfully represent non-positive geometry, and exact amounts must
remain available without color, hover, or pointer input.

This is the application's first visualization primitive. Adding a charting
dependency would increase client size and maintenance surface for one bounded
doughnut and would not remove the need for application-specific signed-value,
grouping, link, and accessibility behavior.

## Decision

Use a shared web component with a small normalized contract: stable key, label,
signed cents, and optional drill-down URL.

- Render positive represented spend as simple SVG circle strokes.
- Exclude zero and negative values from geometry and list them with exact signed
  amounts under `Reductions and adjustments`.
- Keep an adjacent text legend with label, EUR amount, and percentage.
- Keep the five largest ordinary positive categories and deterministically group
  the rest into `Other`; never group `Uncategorized` or
  `Unallocated adjustment`. Expose grouped members through native `details`.
- Assign colors by hashing stable keys into a fixed color-blind-conscious
  palette. This makes a key's color stable across receipt and report views.
- Order by descending signed cents, then German label, then stable key.
- Keep the existing totals panel authoritative for receipt reconciliation.

## Consequences

The chart has no runtime dependency and its signed behavior is explicit and
unit-testable. The SVG is deliberately modest; richer interaction or additional
chart types would require revisiting this decision. Palette collisions are
possible when many categories are visible, so labels and exact values—not color
alone—remain authoritative.
