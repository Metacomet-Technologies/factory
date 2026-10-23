import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { Input } from "./input";
import { Select } from "./select";

describe("Input", () => {
  it("is a labelled, controlled text field that forwards validity", () => {
    function Field() {
      const [value, setValue] = useState("35");
      return (
        <>
          <label htmlFor="delay">Delay</label>
          <Input
            id="delay"
            value={value}
            aria-invalid={value === "x"}
            onChange={(event) => setValue(event.target.value)}
          />
        </>
      );
    }
    render(<Field />);
    const input = screen.getByRole("textbox", { name: "Delay" });
    expect(input).toHaveValue("35");
    expect(input).toHaveAttribute("aria-invalid", "false");
    fireEvent.change(input, { target: { value: "x" } });
    expect(input).toHaveValue("x");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });
});

describe("Select", () => {
  it("is a native, labelled combobox whose value is a form value", () => {
    let submitted: FormDataEntryValue | null = null;
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitted = new FormData(event.currentTarget).get("sensitivity");
        }}
      >
        <label htmlFor="sensitivity">Sensitivity</label>
        <Select id="sensitivity" name="sensitivity" defaultValue="normal">
          <option>low</option>
          <option>normal</option>
          <option>high</option>
        </Select>
        <button type="submit">Save</button>
      </form>,
    );
    const select = screen.getByRole("combobox", { name: "Sensitivity" });
    expect(select).toHaveValue("normal");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    fireEvent.change(select, { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(submitted).toBe("high");
  });
});

describe("Dialog", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Confirm power.cycle</DialogTitle>
            <DialogDescription>Value: —.</DialogDescription>
            <input aria-label="Phrase" />
            <button type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  it("opens a named, described modal that holds focus and closes on Escape", async () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm power.cycle" });
    expect(dialog).toHaveAccessibleDescription("Value: —.");
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes through its own Cancel control", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });
});

describe("design system v2 cleanup (MET-228)", () => {
  const kiosk = join(import.meta.dirname, "../../..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.(tsx?|css)$/.test(name) ? [path] : [];
    });
  const sources = [...files(join(kiosk, "src")), join(kiosk, "scripts/screenshots.ts")].filter(
    (path) => path !== import.meta.filename,
  );

  it.each([
    ["the deleted radius tokens", /radius-(xl|4xl)\b|rounded-(xl|4xl)\b/],
    [
      "the deleted Badge, Card and Tabs primitives",
      /ui\/(badge|card|tabs)["']|\b(Badge|Card|Tabs)\s*[,}]|<(Badge|Card|Tabs)\b/,
    ],
    ["the .divider rule (use Separator)", /\.divider\b|className="divider"/],
  ])("leaves no %s", (_name, pattern) => {
    const hits = sources.filter((path) => pattern.test(readFileSync(path, "utf8")));
    expect(hits.map((path) => relative(kiosk, path))).toEqual([]);
  });
});
