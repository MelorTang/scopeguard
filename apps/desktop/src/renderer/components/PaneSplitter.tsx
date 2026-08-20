import { useRef } from "react";

import {
  MAX_WORKBENCH_PANE_WIDTH,
  MIN_WORKBENCH_PANE_WIDTH,
} from "@scopeguard/domain";

const KEYBOARD_RESIZE_STEP = 24;

export function PaneSplitter(props: {
  index: number;
  leftTitle: string;
  rightTitle: string;
  leftWidth: number;
  rightWidth: number;
  onResize(deltaPixels: number): void;
}): JSX.Element {
  const lastPointerX = useRef<number | null>(null);
  const maximumLeft = Math.min(
    MAX_WORKBENCH_PANE_WIDTH,
    props.leftWidth + props.rightWidth - MIN_WORKBENCH_PANE_WIDTH,
  );

  return (
    <div
      className="pane-splitter"
      role="separator"
      aria-label={`调整窗格宽度：${props.leftTitle} 与 ${props.rightTitle}`}
      aria-orientation="vertical"
      aria-valuemin={MIN_WORKBENCH_PANE_WIDTH}
      aria-valuemax={maximumLeft}
      aria-valuenow={props.leftWidth}
      tabIndex={0}
      onPointerDown={(event) => {
        lastPointerX.current = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (lastPointerX.current === null) return;
        const delta = event.clientX - lastPointerX.current;
        if (delta === 0) return;
        lastPointerX.current = event.clientX;
        props.onResize(delta);
      }}
      onPointerUp={(event) => {
        lastPointerX.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onPointerCancel={() => {
        lastPointerX.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        props.onResize(event.key === "ArrowLeft" ? -KEYBOARD_RESIZE_STEP : KEYBOARD_RESIZE_STEP);
      }}
    >
      <span aria-hidden="true" />
    </div>
  );
}
