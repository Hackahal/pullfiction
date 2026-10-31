import { poseAt } from "./domain";
import type { Actor } from "./types";

/** Share recorded poses only during one synchronous position/camera publication. */
export function withReplayPoses<T>(
  operation: (lookup: typeof poseAt) => T,
  readPose: typeof poseAt = poseAt,
): T {
  const poses = new Map<
    Actor,
    {
      time: number;
      smooth: boolean | undefined;
      pose: ReturnType<typeof poseAt>;
    }
  >();
  let active = true;
  const lookup: typeof poseAt = (actor, time, smooth) => {
    if (!active) return readPose(actor, time, smooth);
    const cached = poses.get(actor);
    if (cached && Object.is(cached.time, time) && cached.smooth === smooth)
      return cached.pose;
    const pose = readPose(actor, time, smooth);
    poses.set(actor, { time, smooth, pose });
    return pose;
  };
  try {
    return operation(lookup);
  } finally {
    active = false;
    poses.clear();
  }
}
