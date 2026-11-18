import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Player } from "./Player";
import { PlayerView } from "./PlayerView";
import { FakeEnvironment } from "./testing";

describe("PlayerView", () => {
  it("creates two stacked video elements and hands the player to its parent", () => {
    const onPlayer = vi.fn();
    const { container, unmount } = render(<PlayerView onPlayer={onPlayer} className="box" />);
    const videos = container.querySelectorAll("video");
    expect(videos).toHaveLength(2);
    for (const v of videos) {
      expect(v.style.position).toBe("absolute");
      expect(v.crossOrigin).toBe("anonymous");
    }
    expect(videos[0]!.style.zIndex).toBe("2");
    expect(videos[1]!.style.zIndex).toBe("1");
    expect(onPlayer).toHaveBeenCalledTimes(1);
    const player = onPlayer.mock.calls[0]![0] as Player;
    expect(player).toBeInstanceOf(Player);
    expect(player.frame).toEqual({ time: 0, position: null, playing: false, speed: 0 });
    unmount();
    expect(onPlayer).toHaveBeenLastCalledWith(null);
    expect(container.querySelectorAll("video")).toHaveLength(0);
  });

  it("uses a supplied environment instead of creating elements", () => {
    const env = new FakeEnvironment();
    const onPlayer = vi.fn();
    const { container, unmount } = render(<PlayerView onPlayer={onPlayer} options={{ environment: env }} />);
    expect(container.querySelectorAll("video")).toHaveLength(0);
    expect(env.videos).toHaveLength(2);
    unmount();
    expect(env.audio.disposed).toBe(true);
  });
});
