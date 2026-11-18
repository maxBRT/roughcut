import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App";
import { EVENTS } from "./types";

describe("App", () => {
  it("shows Home at launch", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Roughcut" })).toBeTruthy();
  });
});

describe("generated types", () => {
  it("exports the event names of spec 3.5.5", () => {
    expect(Object.values(EVENTS)).toEqual([
      "job_updated",
      "source_assets_changed",
      "transcript_appended",
      "transcript_completed",
      "suggestions_ready",
      "suggestions_unavailable",
      "export_finished",
    ]);
  });
});
