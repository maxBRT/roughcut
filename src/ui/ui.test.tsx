import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import {
  AppFrame,
  Button,
  Dialog,
  DropZone,
  EmptyState,
  formatPause,
  InfoList,
  Key,
  ListRow,
  ListRows,
  Notice,
  PauseChip,
  Placeholder,
  ProgressBar,
  Readout,
  ShortcutBar,
  SuggestionBlock,
  Timecode,
  ViewSwitch,
} from "./index";

afterEach(cleanup);

const here = dirname(fileURLToPath(import.meta.url));

describe("tokens.css", () => {
  const css = readFileSync(join(here, "tokens.css"), "utf8");

  it("carries the mockup colours and motion", () => {
    for (const t of [
      "--body: #1B1B19",
      "--accent: #FF4D00",
      "--ink: #EEEEE7",
      "--ink-2: #A6A69E",
      "--oled: #080808",
      "--key: #2A2A27",
      "--ease: cubic-bezier(.2, .8, .2, 1)",
      "--dur-hover: 150ms",
      "--dur-base: 120ms",
      "--dur-press: 90ms",
      "--fs-read: 16px",
    ]) {
      expect(css).toContain(t);
    }
  });

  it("loads only bundled fonts that exist, never Google Fonts", () => {
    expect(css).not.toMatch(/fonts\.googleapis|fonts\.gstatic|https?:/);
    const urls = [...css.matchAll(/url\("\.\/(fonts\/[^"]+)"\)/g)].map((m) => m[1] as string);
    expect(urls.length).toBeGreaterThanOrEqual(12);
    for (const u of urls) expect(existsSync(join(here, u)), u).toBe(true);
  });

  it("components.css honours reduced motion and shows focus", () => {
    const comp = readFileSync(join(here, "components.css"), "utf8");
    expect(comp).toContain("@media (prefers-reduced-motion: reduce)");
    expect(comp).toContain(":focus-visible");
  });
});

describe("components (server render)", () => {
  it("renders the app frame with header pieces", () => {
    const html = renderToString(
      <AppFrame
        project="weekly update · nov 13"
        center={<ViewSwitch value="transcript" />}
        right={
          <>
            <Readout label="kept" value="41:12" />
            <Button variant="primary">export mp4</Button>
          </>
        }
      >
        <p>body</p>
      </AppFrame>,
    );
    expect(html).toContain("rc-frame");
    expect(html).toContain("roughcut");
    expect(html).toContain("weekly update · nov 13");
    expect(html).toContain("rc-key--fill");
    expect(html).toContain("41:12");
  });

  it("omits optional header slots on Home", () => {
    const html = renderToString(<AppFrame>home</AppFrame>);
    expect(html).not.toContain("rc-proj");
    expect(html).not.toContain("rc-top__c");
  });
});

describe("components (DOM)", () => {
  it("Button is flat by default and primary when asked", () => {
    render(
      <>
        <Button>cancel</Button>
        <Button variant="primary" shortcut="enter">
          export
        </Button>
      </>,
    );
    const cancel = screen.getByRole("button", { name: "cancel" });
    expect(cancel.className).toBe("rc-key");
    expect(cancel.getAttribute("type")).toBe("button");
    const exp = screen.getByRole("button", { name: /export/ });
    expect(exp.className).toContain("rc-key--fill");
    expect(exp.querySelector("kbd")?.textContent).toBe("enter");
  });

  it("Key renders a kbd keycap", () => {
    const { container } = render(<Key>ctrl n</Key>);
    const kbd = container.querySelector("kbd.rc-cap");
    expect(kbd?.textContent).toBe("ctrl n");
  });

  it("ViewSwitch marks the current view and reports changes", () => {
    const onChange = vi.fn();
    render(<ViewSwitch value="timeline" onChange={onChange} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.querySelector(".rc-led--on")).not.toBeNull();
    expect(tabs[0]?.querySelector(".rc-led--on")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "transcript" }));
    expect(onChange).toHaveBeenCalledWith("transcript");
  });

  it("ShortcutBar renders hints and a trailing hint", () => {
    const { container } = render(
      <ShortcutBar
        items={[
          { keys: ["space"], label: "play" },
          { keys: ["i", "o"], label: "mark range" },
        ]}
        trailing={{ keys: ["?"], label: "all shortcuts" }}
      />,
    );
    expect(container.querySelectorAll(".rc-hint")).toHaveLength(3);
    expect(container.querySelectorAll("kbd")).toHaveLength(4);
    expect(container.querySelector(".rc-hint--last")?.textContent).toBe("?all shortcuts");
  });

  it("ProgressBar clamps and exposes its value", () => {
    render(<ProgressBar value={0.62} label="Export progress" size="large" detail="1:10 left" />);
    const bar = screen.getByRole("progressbar", { name: "Export progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("62");
    expect(screen.getByText("62%")).toBeTruthy();
    expect(screen.getByText("1:10 left")).toBeTruthy();
    cleanup();
    render(<ProgressBar value={1.7} label="p" />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    cleanup();
    render(<ProgressBar value={null} label="p" size="compact" title="transcribing" />);
    expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
  });

  it("Notice shows retry only when given and is assertive for errors", () => {
    const onRetry = vi.fn();
    render(
      <Notice tone="error" onRetry={onRetry}>
        Claude could not be reached
      </Notice>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Claude could not be reached");
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    cleanup();
    render(<Notice>saved</Notice>);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("Dialog renders only when open and is labelled by its title", () => {
    const { container, rerender } = render(
      <Dialog open={false} title="export">
        x
      </Dialog>,
    );
    expect(container.innerHTML).toBe("");
    const onScrim = vi.fn();
    rerender(
      <Dialog
        open
        title="export"
        shortcut="ctrl e"
        onScrimClick={onScrim}
        footer={<Button>cancel</Button>}
      >
        <InfoList rows={[{ label: "name", value: "weekly.mp4" }]} />
      </Dialog>,
    );
    const dlg = screen.getByRole("dialog", { name: "export" });
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("weekly.mp4")).toBeTruthy();
    fireEvent.click(dlg);
    expect(onScrim).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".rc-scrim") as Element);
    expect(onScrim).toHaveBeenCalledOnce();
  });

  it("ListRow shows name, meta, stat and selection", () => {
    const onActivate = vi.fn();
    render(
      <ListRows heading="recent">
        <ListRow
          name="weekly update · nov 13"
          meta="41:12 kept of 1:04:30"
          stat="edited 2 h ago"
          selected
          onActivate={onActivate}
        />
        <ListRow name="weekly update · nov 6" />
      </ListRows>,
    );
    const opts = screen.getAllByRole("option");
    expect(opts[0]?.getAttribute("aria-selected")).toBe("true");
    expect(opts[0]?.tabIndex).toBe(0);
    expect(opts[1]?.tabIndex).toBe(-1);
    fireEvent.click(opts[0] as Element);
    expect(onActivate).toHaveBeenCalledOnce();
    expect(screen.getByText("edited 2 h ago")).toBeTruthy();
  });

  it("DropZone shows its title, action and active state", () => {
    const { container } = render(
      <DropZone active action={<Button variant="primary">pick footage</Button>} />,
    );
    expect(screen.getByText("drop this week's footage")).toBeTruthy();
    expect(screen.getByRole("button", { name: "pick footage" })).toBeTruthy();
    expect(container.querySelector(".rc-drop--active")).not.toBeNull();
  });

  it("Readout and Timecode render mono figures", () => {
    const { container } = render(
      <>
        <Readout label="kept" value="41:12" />
        <Timecode value="0:28.2" total="41:12" />
      </>,
    );
    expect(container.querySelector(".rc-readout__v")?.textContent).toBe("41:12");
    expect(container.querySelector(".rc-tc")?.textContent).toBe("0:28.2/ 41:12");
  });

  it("SuggestionBlock shows reason and A / D hints when current", () => {
    const { container } = render(
      <SuggestionBlock reason="retake" position="1 of 3" current>
        So the first thing you'll notice
      </SuggestionBlock>,
    );
    expect(container.querySelector(".rc-sug--bar")).not.toBeNull();
    expect(container.querySelector(".rc-sug__why")?.textContent).toBe("retake · 1 of 3acutdkeep");
    cleanup();
    const other = render(
      <SuggestionBlock reason="filler" marker="underline">
        uh
      </SuggestionBlock>,
    );
    expect(other.container.querySelectorAll("kbd")).toHaveLength(0);
    expect(other.container.querySelector(".rc-sug__text--underline")).not.toBeNull();
  });

  it("PauseChip formats its length and states", () => {
    expect(formatPause(3.14)).toBe("pause 3.1s");
    const { container } = render(<PauseChip seconds={3.1} cut selected />);
    const chip = container.querySelector(".rc-pause");
    expect(chip?.textContent).toBe("pause 3.1s");
    expect(chip?.className).toContain("rc-pause--cut");
    expect(chip?.className).toContain("rc-pause--sel");
  });

  it("EmptyState and Placeholder render", () => {
    const { container } = render(
      <>
        <EmptyState title="no projects yet" detail="drop a file to start" />
        <Placeholder label="no video yet" shape="video" />
      </>,
    );
    expect(screen.getByText("no projects yet")).toBeTruthy();
    expect(container.querySelector(".rc-placeholder--video")?.textContent).toBe("no video yet");
  });
});
