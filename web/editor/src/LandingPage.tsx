import type { MouseEvent, ReactNode } from "react";

export type LandingDestination = "workspace" | "projects" | "logs" | "rankings";

export const landingFaq = [
  [
    "Do I need WoW installed?",
    "No. Pull Fiction runs in your browser. Raid assets download when you open a replay or plan and are cached for your next visit.",
  ],
  [
    "Can I plan without a log?",
    "Yes. Start with an empty raid, place players and raid markers, and draw your strategy. Or pause a recorded run and plan from that moment.",
  ],
  [
    "Which versions can I use?",
    "Classic Era and Season of Discovery. Choose your version in the workspace to find the relevant raids, reports and rankings.",
  ],
  [
    "Where are my plans saved?",
    "Plans and saved runs stay in this browser on this device. Export a project to keep a backup or move it to another browser.",
  ],
] as const;

export function LandingPage({
  onNavigate,
  onCreatePlan,
  onReturnToEditor,
}: {
  onNavigate?: (destination: LandingDestination) => void;
  onCreatePlan?: (map?: number) => void;
  onReturnToEditor?: () => void;
}) {
  function destinationLink(
    destination: LandingDestination,
    text: ReactNode,
    className?: string,
    map?: number,
  ) {
    const create = destination === "projects";
    const href = `/?page=${destination}${create ? "&create=1" : ""}${map ? `&map=${map}` : ""}`;
    return (
      <a
        className={className}
        href={href}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          if (create && onCreatePlan) {
            event.preventDefault();
            onCreatePlan(map);
          } else if (onNavigate) {
            event.preventDefault();
            onNavigate(destination);
          }
        }}
      >
        {text}
      </a>
    );
  }
  return (
    <div className="pf-landing" id="top">
      <a className="pf-skip" href="#landing-main">
        Skip to content
      </a>
      <header className="pf-masthead pf-width">
        <a className="pf-wordmark" href="#top" aria-label="Pull Fiction home">
          Pull <span>Fiction</span>
        </a>
        <nav aria-label="Landing page">
          <a href="#how-it-works">How it works</a>
          <a href="#raids">Raids</a>
          <a href="#questions">Questions</a>
        </nav>
        {destinationLink("workspace", "Open workspace", "pf-workspace-link")}
      </header>
      <main id="landing-main" tabIndex={-1}>
        <section className="pf-hero pf-width" aria-labelledby="landing-title">
          <div className="pf-hero-copy">
            <h1 id="landing-title">
              Replay the run.
              <br />
              Rethink the pull.
            </h1>
            <div className="pf-hero-intro">
              <p>
                A 3D raid replay and planner for WoW Classic. Bring your
                Warcraft Logs into the raid, see what happened, and work out
                what to change.
              </p>
              <div className="pf-actions">
                {destinationLink(
                  "logs",
                  <>
                    Find a run <Arrow />
                  </>,
                  "pf-button",
                )}
                {destinationLink("projects", "Start a plan", "pf-text-link")}
              </div>
              <p className="pf-note">
                In your browser. No game installation needed.
              </p>
            </div>
          </div>
          <fieldset className="pf-product-preview">
            <legend className="pf-sr-only">
              See Pull Fiction in replay or planning mode
            </legend>
            <input
              className="pf-sr-only"
              id="pf-preview-replay"
              name="pf-preview"
              type="radio"
              defaultChecked
            />
            <input
              className="pf-sr-only"
              id="pf-preview-plan"
              name="pf-preview"
              type="radio"
            />
            <div className="pf-preview-bar">
              <div className="pf-preview-modes">
                <label htmlFor="pf-preview-replay">Replay a run</label>
                <label htmlFor="pf-preview-plan">Plan a pull</label>
              </div>
              <span>Inside Pull Fiction</span>
            </div>
            <div className="pf-preview-sheets">
              <figure className="pf-replay-sheet">
                <img
                  src="/landing/replay.jpg"
                  width="1280"
                  height="720"
                  fetchPriority="high"
                  alt="Pull Fiction replaying a real Molten Core run in 3D, with native raid frames and the full raid timeline."
                />
                <figcaption>
                  <strong>See the whole run.</strong> Follow the raid in 3D and
                  move through every pull on the timeline.
                </figcaption>
              </figure>
              <figure className="pf-plan-sheet">
                <img
                  src="/landing/plan.jpg"
                  width="1280"
                  height="720"
                  loading="lazy"
                  alt="Pull Fiction's planning workspace in Onyxia's Lair, showing the 3D encounter, drawing tools, raid markers and plan timeline."
                />
                <figcaption>
                  <strong>Make the next pull yours.</strong> Place players, draw
                  ranges and routes, and build the plan in the raid itself.
                </figcaption>
              </figure>
            </div>
          </fieldset>
        </section>

        <section
          id="how-it-works"
          className="pf-workflow pf-width"
          aria-labelledby="workflow-title"
        >
          <div className="pf-workflow-heading">
            <h2 id="workflow-title">
              From what happened
              <br />
              to what happens next.
            </h2>
            <p>
              A log tells you when. The replay shows you where. Put both to work
              before your next raid night.
            </p>
          </div>
          <div className="pf-workflow-body">
            <figure className="pf-planning-image">
              <img
                src="/landing/tactical-plan.jpg"
                width="1280"
                height="720"
                loading="lazy"
                alt="A real Molten Core tactical plan with a 30-yard range marking attached to Lucifron, editable properties and timed plan pages."
              />
              <figcaption>
                Draw in yards. Plan in the actual encounter.
              </figcaption>
            </figure>
            <div className="pf-workflow-steps">
              <article>
                <h3>Find your raid night.</h3>
                <p>
                  Look up your guild or character on Warcraft Logs. Follow them
                  to keep their reports close, or browse rankings for a run
                  worth studying.
                </p>
                {destinationLink(
                  "logs",
                  "Find guilds and players",
                  "pf-text-link",
                )}
              </article>
              <article>
                <h3>Pause at the moment.</h3>
                <p>
                  Replay a pull in 3D or on the tactical map. Follow positions,
                  casts and the encounter timeline to see how it unfolded.
                </p>
              </article>
              <article>
                <h3>Change the next pull.</h3>
                <p>
                  Turn that moment into a plan. Move players, mark positions and
                  draw routes or ranges. Organise your strategy into named
                  pages.
                </p>
                {destinationLink(
                  "projects",
                  "Create a raid plan",
                  "pf-text-link",
                )}
              </article>
            </div>
          </div>
        </section>

        <section
          className="pf-library-feature"
          aria-labelledby="library-feature-title"
        >
          <div className="pf-width pf-library-feature-inner">
            <div>
              <h2 id="library-feature-title">
                Your runs.
                <br />
                Your working notes.
              </h2>
              <p>
                Keep the runs you want to learn from and the plans you are still
                working on. Raid artwork, boss progress and last-viewed times
                make the right one easy to find.
              </p>
              <p>
                Pin a plan for raid night. Duplicate it to try another approach.
                Export a copy to keep it.
              </p>
              {destinationLink(
                "workspace",
                "Open your workspace",
                "pf-button pf-button-dark",
              )}
            </div>
            <figure>
              <img
                className="pf-library-overview"
                src="/landing/library.jpg"
                width="1280"
                height="720"
                loading="lazy"
                alt="The Pull Fiction saved-runs library with raid artwork, boss completion, clear time and last-viewed columns."
              />
              <div
                className="pf-library-details"
                role="group"
                aria-label="Saved run details"
              >
                <img
                  className="pf-library-run-detail"
                  src="/landing/library.jpg"
                  width="1280"
                  height="720"
                  loading="lazy"
                  alt="Close-up of a saved Molten Core run with its raid artwork and name."
                />
                <img
                  className="pf-library-metrics-detail"
                  src="/landing/library.jpg"
                  width="1280"
                  height="720"
                  loading="lazy"
                  alt="Close-up of the saved run's clear time, boss progress and last-viewed columns."
                />
              </div>
              <figcaption>
                A personal library for the runs and plans you come back to.
              </figcaption>
            </figure>
          </div>
        </section>

        <section
          id="raids"
          className="pf-raids pf-width"
          aria-labelledby="raids-title"
        >
          <div className="pf-raids-heading">
            <h2 id="raids-title">Back into familiar territory.</h2>
            <p>
              Classic Era and Season of Discovery. Start with a raid, then make
              it your plan.
            </p>
          </div>
          <div className="pf-raid-list">
            {[
              { map: 409, zone: 2000, name: "Molten Core" },
              { map: 249, zone: 2001, name: "Onyxia's Lair" },
              { map: 469, zone: 2002, name: "Blackwing Lair" },
              { map: 531, zone: 2005, name: "Ahn'Qiraj" },
              { map: 533, zone: 2006, name: "Naxxramas" },
            ].map(({ map, zone, name }) => (
              <div key={map}>
                {destinationLink(
                  "projects",
                  <>
                    <img
                      src={`https://assets.rpglogs.com/img/warcraft/zones/zone-${zone}.png`}
                      width="72"
                      height="72"
                      loading="lazy"
                      alt=""
                      referrerPolicy="no-referrer"
                    />
                    <span>{name}</span>
                  </>,
                  "pf-raid-link",
                  map,
                )}
              </div>
            ))}
          </div>
          <p className="pf-raids-more">
            Looking for a speed clear or a top character performance?{" "}
            {destinationLink("rankings", "Browse rankings", "pf-text-link")}
          </p>
        </section>

        <section
          id="questions"
          className="pf-faq pf-width"
          aria-labelledby="questions-title"
        >
          <h2 id="questions-title">Before the first pull.</h2>
          <dl>
            {landingFaq.map(([question, answer]) => (
              <div key={question}>
                <dt>{question}</dt>
                <dd>{answer}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="pf-closing" aria-labelledby="closing-title">
          <div className="pf-width pf-closing-inner">
            <h2 id="closing-title">
              Bring a run.
              <br />
              Leave with a plan.
            </h2>
            <div>
              <p>
                Your next raid night starts with a closer look at the last one.
              </p>
              {destinationLink(
                "logs",
                <>
                  Find a run <Arrow />
                </>,
                "pf-button",
              )}
            </div>
          </div>
        </section>
      </main>
      <footer className="pf-footer pf-width">
        <a className="pf-wordmark" href="#top">
          Pull <span>Fiction</span>
        </a>
        <p>A raid replay and planning tool for WoW Classic.</p>
        <nav aria-label="Footer">
          {destinationLink("workspace", "Workspace")}
          <a href="https://github.com/Hackahal/pullfiction">GitHub</a>
          <a href="https://github.com/Hackahal/pullfiction/issues/new/choose">
            Feedback
          </a>
          {onReturnToEditor && (
            <button onClick={onReturnToEditor}>Return to editor</button>
          )}
        </nav>
        <p className="pf-footer-credit">
          Independent community project. Not affiliated with Blizzard
          Entertainment or Warcraft Logs. Raid artwork courtesy of Warcraft
          Logs.
        </p>
      </footer>
    </div>
  );
}

function Arrow() {
  return (
    <svg
      aria-hidden="true"
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
    >
      <path d="M4 12h15m-6-6 6 6-6 6" />
    </svg>
  );
}
