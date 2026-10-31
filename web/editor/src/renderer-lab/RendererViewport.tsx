import type { ReactNode } from "react";

// Bevy owns the canvas for the lifetime of its runtime. React Fast Refresh can
// remount the controls; replacing the canvas then leaves Bevy drawing off-DOM.
let canvas: HTMLCanvasElement | undefined = import.meta.hot?.data.canvas;
if (import.meta.hot)
  import.meta.hot.dispose((data) => {
    data.canvas = canvas;
  });

export function RendererViewport({ children }: { children?: ReactNode }) {
  return (
    <div
      className="renderer-lab-stage"
      ref={(host) => {
        if (!host) return;
        if (!canvas) {
          canvas = document.createElement("canvas");
          canvas.id = "benilla";
          canvas.tabIndex = 0;
          canvas.setAttribute("aria-label", "Renderer fixture viewport");
        }
        host.prepend(canvas);
      }}
    >
      {children}
    </div>
  );
}
