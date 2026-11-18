/**
 * A thin React host for the player: a positioned box in which the `Player` creates its two
 * stacked video elements. The parent receives the instance through `onPlayer` (and `null`
 * when the box unmounts) and drives it from the store; this component renders nothing else.
 */
import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import type { PlayerOptions } from "./Player";
import { Player } from "./Player";

export interface PlayerViewProps {
  /** Receives the player once the box is mounted, and null when it unmounts. */
  onPlayer: (player: Player | null) => void;
  /** Options for the player (not `container`, which is this box). Read once, on mount. */
  options?: Omit<PlayerOptions, "container">;
  className?: string;
  style?: CSSProperties;
}

const BOX: CSSProperties = { position: "relative", overflow: "hidden", background: "#000" };

/** Hosts the player's two video elements and hands the `Player` to its parent. */
export function PlayerView({ onPlayer, options, className, style }: PlayerViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const onPlayerRef = useRef(onPlayer);
  onPlayerRef.current = onPlayer;
  const optionsRef = useRef(options);

  useEffect(() => {
    const container = box.current;
    if (!container) return;
    const player = new Player({ ...optionsRef.current, container: optionsRef.current?.environment ? undefined : container });
    onPlayerRef.current(player);
    return () => {
      onPlayerRef.current(null);
      player.dispose();
    };
  }, []);

  return <div ref={box} className={className} style={{ ...BOX, ...style }} data-testid="player-view" />;
}
