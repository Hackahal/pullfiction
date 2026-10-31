import type { KonvaEventObject } from "konva/lib/Node";
import type { Actor, Cast } from "./types";
import type { EditorController } from "./controller";
import { castLabel } from "./timeline-model";

export interface TimelineHover {
  x: number;
  y: number;
  text: string;
  actor?: Actor;
  cast?: Cast;
  spell?: number;
  buff?: boolean;
}
const stopMouseDown = (event: KonvaEventObject<MouseEvent>) => {
  event.cancelBubble = true;
};
export function timelineCastHandlers(
  controller: Pick<EditorController, "inspectCast">,
  actor: Actor,
  cast: Cast,
  index: number,
  onHover: (hover: TimelineHover | null) => void,
) {
  return {
    onMouseDown: stopMouseDown,
    onClick(event: KonvaEventObject<MouseEvent>) {
      event.cancelBubble = true;
      controller.inspectCast(actor.key, index);
      onHover(null);
    },
    onMouseEnter(event: KonvaEventObject<MouseEvent>) {
      if (event.target.getStage()?.getPointerPosition())
        onHover({
          x: event.evt.clientX,
          y: event.evt.clientY,
          text: castLabel(cast),
          actor,
          cast,
          spell: cast.spell,
        });
    },
    onMouseLeave() {
      onHover(null);
    },
  };
}
