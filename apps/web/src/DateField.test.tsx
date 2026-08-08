// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DateField,
  dateRangeError,
  displayDate,
  parseDateInput,
} from "./DateField.js";

describe("German date fields", () => {
  it.each([
    ["29.02.2028", "2028-02-29"],
    ["2026-03-04", "2026-03-04"],
    ["01.01.0001", "0001-01-01"],
  ])("parses %s strictly", (input, iso) => {
    expect(parseDateInput(input)).toEqual({ iso, error: null });
    expect(displayDate(iso)).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });

  it.each(["29.02.2026", "31.04.2026", "3/4/2026", "03.04.26", "03.04."])(
    "rejects invalid or ambiguous input %s",
    (input) => expect(parseDateInput(input).iso).toBeNull(),
  );

  it("validates range ordering", () => {
    expect(dateRangeError("02.08.2026", "01.08.2026")).toMatch(/before/);
    expect(dateRangeError("01.08.2026", "02.08.2026")).toBeNull();
    expect(dateRangeError("invalid", "02.08.2026")).toBeNull();
    expect(parseDateInput("", false)).toEqual({ iso: "", error: null });
    expect(parseDateInput("").iso).toBeNull();
    expect(displayDate("not-a-date")).toBe("not-a-date");
  });

  it("preserves partial input and normalizes ISO paste on blur", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <DateField
        id="purchase-date"
        label="Purchase date"
        value="03."
        onChange={onChange}
      />,
    );
    expect(screen.getByLabelText("Purchase date")).toHaveValue("03.");
    fireEvent.blur(screen.getByLabelText("Purchase date"));
    expect(onChange).not.toHaveBeenCalled();
    rerender(
      <DateField
        id="purchase-date"
        label="Purchase date"
        value="2026-08-03"
        onChange={onChange}
      />,
    );
    fireEvent.blur(screen.getByLabelText("Purchase date"));
    expect(onChange).toHaveBeenLastCalledWith("03.08.2026");
  });

  it("announces optional date fields", () => {
    render(
      <DateField
        id="from"
        label="From"
        value=""
        required={false}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "From (optional)" }),
    ).toBeVisible();
  });

  it("exposes an accessible native picker when supported", async () => {
    const showPicker = vi.fn();
    Object.defineProperty(HTMLInputElement.prototype, "showPicker", {
      configurable: true,
      value: showPicker,
    });
    const onChange = vi.fn();
    const { container, unmount } = render(
      <DateField
        id="from"
        label="From"
        value="01.08.2026"
        error="Check this date."
        onChange={onChange}
      />,
    );
    const button = await screen.findByRole("button", {
      name: "Open calendar",
    });
    fireEvent.click(button);
    expect(showPicker).toHaveBeenCalledOnce();
    expect(screen.getByText("Check this date.")).toHaveAttribute(
      "id",
      "from-error",
    );
    const nativePicker = container.querySelector(".date-field__native");
    if (!nativePicker) throw new Error("native picker missing");
    fireEvent.change(nativePicker, {
      target: { value: "2026-08-03" },
    });
    expect(onChange).toHaveBeenLastCalledWith("03.08.2026");
    unmount();
    await waitFor(() => expect(button).not.toBeInTheDocument());
    Reflect.deleteProperty(HTMLInputElement.prototype, "showPicker");
  });
});
