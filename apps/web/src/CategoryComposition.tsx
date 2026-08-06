const euros = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});

/** Fixed color-blind-conscious palette. Stable keys are hashed into this list. */
export const compositionPalette = [
  "#176b87",
  "#9a4f14",
  "#5b4b9a",
  "#287a5a",
  "#a43f5c",
  "#59636d",
  "#8a6d16",
  "#3f6a3c",
] as const;

export type CompositionBucket = {
  key: string;
  label: string;
  signedCents: number;
  drillDownUrl?: string | undefined;
};

export type CompositionSlice = CompositionBucket & {
  color: string;
  percentage: number;
  members?: CompositionBucket[] | undefined;
};

export type CompositionModel = {
  positive: CompositionSlice[];
  reductions: CompositionBucket[];
  positiveTotalCents: number;
};

function compareBuckets(left: CompositionBucket, right: CompositionBucket) {
  return (
    right.signedCents - left.signedCents ||
    left.label.localeCompare(right.label, "de") ||
    left.key.localeCompare(right.key)
  );
}

export function bucketColor(key: string): string {
  if (key === "other") return "#6f7771";
  let hash = 2166136261;
  for (const character of key) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (
    compositionPalette[(hash >>> 0) % compositionPalette.length] ?? "#176b87"
  );
}

export function buildComposition(
  buckets: CompositionBucket[],
): CompositionModel {
  const ordered = [...buckets].sort(compareBuckets);
  const reductions = ordered.filter((bucket) => bucket.signedCents <= 0);
  const positive = ordered.filter((bucket) => bucket.signedCents > 0);
  const protectedKeys = new Set(["uncategorized", "unallocated-adjustment"]);
  const protectedBuckets = positive.filter((bucket) =>
    protectedKeys.has(bucket.key),
  );
  const ordinary = positive.filter((bucket) => !protectedKeys.has(bucket.key));
  const visible = ordinary.slice(0, 5);
  const grouped = ordinary.slice(5);
  const represented: (CompositionBucket & {
    members?: CompositionBucket[] | undefined;
  })[] = [...visible, ...protectedBuckets];
  if (grouped.length)
    represented.push({
      key: "other",
      label: "Other",
      signedCents: grouped.reduce(
        (total, bucket) => total + bucket.signedCents,
        0,
      ),
      members: grouped,
    });
  represented.sort(compareBuckets);
  const positiveTotalCents = represented.reduce(
    (total, bucket) => total + bucket.signedCents,
    0,
  );
  return {
    positive: represented.map((bucket) => ({
      ...bucket,
      color: bucketColor(bucket.key),
      percentage:
        positiveTotalCents === 0
          ? 0
          : (bucket.signedCents / positiveTotalCents) * 100,
    })),
    reductions,
    positiveTotalCents,
  };
}

export function CategoryComposition({
  title,
  buckets,
}: {
  title: string;
  buckets: CompositionBucket[];
}) {
  const model = buildComposition(buckets);
  const headingId = `${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}-composition`;
  let offset = 0;
  return (
    <section className="category-composition panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      <p className="composition-explanation">
        Percentages show each category’s share of positive represented spend.
      </p>
      {model.positive.length ? (
        <div className="composition-layout">
          <svg
            className="composition-ring"
            viewBox="0 0 100 100"
            role="img"
            aria-label={`Positive represented spend: ${euros.format(model.positiveTotalCents / 100)}`}
          >
            <circle
              cx="50"
              cy="50"
              r="38"
              className="composition-ring__track"
            />
            {model.positive.map((slice) => {
              const start = offset;
              offset += slice.percentage;
              return (
                <circle
                  key={slice.key}
                  aria-hidden="true"
                  cx="50"
                  cy="50"
                  r="38"
                  pathLength="100"
                  fill="none"
                  stroke={slice.color}
                  strokeWidth="15"
                  strokeDasharray={`${slice.percentage} ${100 - slice.percentage}`}
                  strokeDashoffset={-start}
                  transform="rotate(-90 50 50)"
                />
              );
            })}
          </svg>
          <ul className="composition-legend">
            {model.positive.map((slice) => (
              <li key={slice.key}>
                <span
                  className="composition-swatch"
                  style={{ backgroundColor: slice.color }}
                  aria-hidden="true"
                />
                <div>
                  {slice.drillDownUrl ? (
                    <a href={slice.drillDownUrl}>{slice.label}</a>
                  ) : (
                    <strong>{slice.label}</strong>
                  )}
                  <span>
                    {euros.format(slice.signedCents / 100)} ·{" "}
                    {slice.percentage.toFixed(1)}%
                  </span>
                  {slice.members && (
                    <details>
                      <summary>
                        Other contains {slice.members.length} categories
                      </summary>
                      <ul>
                        {slice.members.map((member) => (
                          <li key={member.key}>
                            {member.label}:{" "}
                            {euros.format(member.signedCents / 100)}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="muted">No positive composition to chart.</p>
      )}
      {model.reductions.length > 0 && (
        <div className="composition-reductions">
          <h3>Reductions and adjustments</h3>
          <ul>
            {model.reductions.map((bucket) => (
              <li key={bucket.key}>
                <span>{bucket.label}</span>
                <strong>{euros.format(bucket.signedCents / 100)}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
