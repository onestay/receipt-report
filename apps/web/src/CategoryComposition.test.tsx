// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  CategoryComposition,
  bucketColor,
  buildComposition,
  type CompositionBucket,
} from "./CategoryComposition.js";

describe("category composition", () => {
  it("constructs positive geometry and keeps signed adjustments in text", () => {
    const model = buildComposition([
      { key: "food", label: "Food", signedCents: 800 },
      { key: "uncategorized", label: "Uncategorized", signedCents: 200 },
      {
        key: "unallocated-adjustment",
        label: "Unallocated adjustment",
        signedCents: -50,
      },
      { key: "returns", label: "Returns", signedCents: 0 },
    ]);
    expect(model.positiveTotalCents).toBe(1000);
    expect(model.positive.map((item) => [item.key, item.percentage])).toEqual([
      ["food", 80],
      ["uncategorized", 20],
    ]);
    expect(model.reductions.map((item) => item.signedCents)).toEqual([0, -50]);
  });

  it("groups ordinary categories deterministically without grouping protected buckets", () => {
    const ordinary: CompositionBucket[] = Array.from(
      { length: 8 },
      (_, index) => ({
        key: `category-${index}`,
        label: `Category ${index}`,
        signedCents: index < 2 ? 100 : 100 - index,
      }),
    );
    const model = buildComposition([
      ...ordinary,
      { key: "uncategorized", label: "Uncategorized", signedCents: 1 },
      {
        key: "unallocated-adjustment",
        label: "Unallocated adjustment",
        signedCents: 2,
      },
    ]);
    expect(model.positive).toHaveLength(8);
    expect(
      model.positive.find((item) => item.key === "other")?.members,
    ).toHaveLength(3);
    expect(model.positive.some((item) => item.key === "uncategorized")).toBe(
      true,
    );
    expect(
      model.positive.some((item) => item.key === "unallocated-adjustment"),
    ).toBe(true);
    expect(bucketColor("category-1")).toBe(bucketColor("category-1"));
  });

  it("renders exact accessible legend text, drill-downs, and empty signed state", () => {
    const { rerender } = render(
      <CategoryComposition
        title="Categories"
        buckets={[
          {
            key: "food",
            label: "Food",
            signedCents: 750,
            drillDownUrl: "/receipts?category=food",
          },
          { key: "household", label: "Household", signedCents: 250 },
        ]}
      />,
    );
    expect(screen.getByRole("img")).toHaveAccessibleName(
      /Positive represented spend: 10,00/,
    );
    expect(screen.getByRole("link", { name: "Food" })).toHaveAttribute(
      "href",
      "/receipts?category=food",
    );
    expect(screen.getByText("7,50 € · 75.0%")).toBeVisible();

    rerender(
      <CategoryComposition
        title="Categories"
        buckets={[{ key: "returns", label: "Returns", signedCents: -300 }]}
      />,
    );
    expect(screen.getByText("No positive composition to chart.")).toBeVisible();
    const reductions = screen.getByRole("heading", {
      name: "Reductions and adjustments",
    }).parentElement;
    if (!reductions) throw new Error("reductions missing");
    expect(within(reductions).getByText(/-3,00/)).toBeVisible();
  });

  it("exposes grouped Other members in expandable text", () => {
    render(
      <CategoryComposition
        title="Categories"
        buckets={Array.from({ length: 7 }, (_, index) => ({
          key: `category-${index}`,
          label: `Category ${index}`,
          signedCents: 100 - index,
        }))}
      />,
    );
    const summary = screen.getByText("Other contains 2 categories");
    fireEvent.click(summary);
    expect(screen.getByText(/Category 5:/)).toBeVisible();
    expect(screen.getByText(/Category 6:/)).toBeVisible();
  });
});
