import { useEffect, useRef, useState } from "react";

const germanDatePattern = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export type ParsedDate =
  { iso: string; error: null } | { iso: null; error: string };

export function parseDateInput(value: string, required = true): ParsedDate {
  const trimmed = value.trim();
  if (!trimmed)
    return required
      ? { iso: null, error: "Enter a date as DD.MM.YYYY." }
      : { iso: "", error: null };
  const german = germanDatePattern.exec(trimmed);
  const iso = isoDatePattern.exec(trimmed);
  const parts = german
    ? {
        year: Number(german[3]),
        month: Number(german[2]),
        day: Number(german[1]),
      }
    : iso
      ? { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }
      : null;
  if (!parts || !validDate(parts.year, parts.month, parts.day))
    return { iso: null, error: "Enter a valid date as DD.MM.YYYY." };
  return {
    iso: `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    error: null,
  };
}

export function displayDate(value: string): string {
  const parsed = parseDateInput(value, false);
  if (parsed.error || !parsed.iso) return value;
  const [year, month, day] = parsed.iso.split("-");
  return `${day}.${month}.${year}`;
}

export function dateRangeError(from: string, to: string): string | null {
  const parsedFrom = parseDateInput(from);
  const parsedTo = parseDateInput(to);
  if (parsedFrom.error || parsedTo.error || !parsedFrom.iso || !parsedTo.iso)
    return null;
  return parsedFrom.iso > parsedTo.iso
    ? "The From date must be on or before the To date."
    : null;
}

type DateFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  error?: string | undefined;
  className?: string;
};

export function DateField({
  id,
  label,
  value,
  onChange,
  required = true,
  error,
  className = "field",
}: DateFieldProps) {
  const picker = useRef<HTMLInputElement>(null);
  const [pickerSupported, setPickerSupported] = useState(false);
  useEffect(
    () => setPickerSupported(typeof picker.current?.showPicker === "function"),
    [],
  );
  const errorId = `${id}-error`;
  return (
    <div className={className}>
      <label htmlFor={id}>
        {label} {!required && <span>optional</span>}
      </label>
      <div className="date-field">
        <input
          id={id}
          name={id}
          aria-label={label}
          value={value}
          placeholder="DD.MM.YYYY"
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => {
            const parsed = parseDateInput(value, required);
            if (!parsed.error && parsed.iso) onChange(displayDate(parsed.iso));
          }}
        />
        <input
          ref={picker}
          className="date-field__native"
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          value={parseDateInput(value, false).iso ?? ""}
          onChange={(event) => onChange(displayDate(event.target.value))}
        />
        {pickerSupported && (
          <button
            type="button"
            className="button button--quiet date-field__button"
            aria-label="Open calendar"
            onClick={() => picker.current?.showPicker()}
          >
            <span aria-hidden="true">📅</span>
          </button>
        )}
      </div>
      {error && (
        <small id={errorId} className="field-error">
          {error}
        </small>
      )}
    </div>
  );
}
